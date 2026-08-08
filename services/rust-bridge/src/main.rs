#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    future::Future,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, FromRequest, FromRequestParts, Multipart, Query, Request, State,
    },
    http::{
        header::{
            CACHE_CONTROL, CONNECTION, CONTENT_ENCODING, CONTENT_TYPE, COOKIE, HOST, LOCATION,
            ORIGIN, REFERER, REFERRER_POLICY, SET_COOKIE, UPGRADE, VARY,
        },
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Method as HttpMethod, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use services::{GitService, TerminalService};
#[cfg(test)]
use tokio::sync::oneshot;
use tokio::{
    fs,
    io::AsyncReadExt,
    sync::{mpsc, watch, Mutex, Notify, OwnedSemaphorePermit, RwLock, Semaphore},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as UpstreamWsMessage},
};
use uuid::Uuid;

mod acp;
mod agui;
#[allow(clippy::all)]
mod agui_generated;
mod attachments;
mod config;
mod health;
mod observability;
mod owner_watchdog;
mod path_policy;
mod preview;
mod protocol_constants;
mod push;
mod replay;
mod resource_limits;
mod rpc;
mod services;
mod storage;

use attachments::{
    infer_image_content_type_from_path, save_multipart_attachment, ATTACHMENT_MULTIPART_MAX_BYTES,
};
use config::BridgeConfig;
use health::{
    bridge_status, runtime_activity, BridgeDeviceConnection, BridgeOperationalStatus, BridgeStatus,
    QueueStatus,
};
use observability::OperationalMetrics;
use path_policy::{PathKind, PathPolicy};
use preview::{
    normalize_browser_preview_target_url, BrowserPreviewResolvedSession, BrowserPreviewService,
    BROWSER_PREVIEW_SESSION_TTL,
};
use push::{parse_push_event_preferences, truncate_chars, PushEventPreferences, PushRegistryStore};
use replay::NotificationReplay;
use resource_limits::{
    FILESYSTEM_LIST_MAX_ENTRIES, LOCAL_IMAGE_MAX_BYTES, NOTIFICATION_MAX_BYTES,
    PREVIEW_BUFFERED_RESPONSE_MAX_BYTES, PREVIEW_REQUEST_MAX_BYTES, PUSH_DEVICE_NAME_MAX_BYTES,
    PUSH_ID_MAX_BYTES, PUSH_PLATFORM_MAX_BYTES, PUSH_PREVIEW_MAX_BYTES, PUSH_PREVIEW_MAX_THREADS,
    PUSH_TOKEN_MAX_BYTES, QUEUE_MAX_BYTES_PER_THREAD, QUEUE_MAX_CONTENT_BYTES,
    QUEUE_MAX_ITEMS_PER_THREAD, QUEUE_MAX_ITEM_BYTES, REPLAY_MAX_BYTES, REPLAY_RESPONSE_MAX_BYTES,
    UI_SURFACE_MAX_ACTIONS, UI_SURFACE_MAX_BLOCKS, UI_SURFACE_MAX_BYTES,
    UI_SURFACE_MAX_ITEMS_PER_BLOCK, UI_SURFACE_MAX_TEXT_BYTES,
};
use rpc::{is_forwarded_method, parse_client_request_id, parse_request, RpcRequestParseError};

mod app_state;
mod bridge_protocol;
mod client_hub;
mod http_routes;
mod interaction_validation;
mod pairing;
mod preview_proxy;
mod push_delivery;
mod queue_service;
mod runtime_backend;
mod websocket_transport;
mod workspace_auth;

use agui::*;
use app_state::*;
use bridge_protocol::*;
use client_hub::*;
use http_routes::*;
use interaction_validation::*;
use pairing::*;
use preview_proxy::*;
use protocol_constants::*;
use push_delivery::*;
use runtime_backend::*;
use websocket_transport::*;
use workspace_auth::*;

#[tokio::main]
async fn main() {
    let config = match BridgeConfig::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let owner_pid = match owner_watchdog::owner_pid_from_env() {
        Ok(owner_pid) => owner_pid,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    if let Some(owner_pid) = owner_pid {
        if !owner_watchdog::process_is_alive(owner_pid) {
            eprintln!("owning process {owner_pid} is not running; refusing to start");
            std::process::exit(1);
        }
        eprintln!("bridge will exit when process {owner_pid} does");
    }

    if !config.auth_enabled && config.allow_insecure_no_auth {
        eprintln!(
            "bridge auth is disabled by BRIDGE_ALLOW_INSECURE_NO_AUTH=true (local development only)"
        );
    }
    if config.allow_query_token_auth {
        eprintln!(
            "query-token auth is enabled (BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true); prefer Authorization headers instead"
        );
    }

    let metrics = Arc::new(OperationalMetrics::new());
    let hub = Arc::new(ClientHub::new());
    let (bind_addr, listener, backend) =
        match bind_then_start_backend(&config.host, config.port, || {
            RuntimeBackend::start(&config, hub.clone(), metrics.clone())
        })
        .await
        {
            Ok(started) => started,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
    let path_policy = Arc::new(
        PathPolicy::with_attachments_root(
            config.workdir.clone(),
            config.allow_outside_root_cwd,
            Some(config.attachments_dir.clone()),
        )
        .expect("validated bridge path policy"),
    );

    let terminal = Arc::new(TerminalService::new(path_policy.clone()));
    let git = Arc::new(GitService::new(terminal.clone(), path_policy.clone()));
    let preview = Arc::new(BrowserPreviewService::new(
        config.port,
        config.preview_port,
        config.preview_connect_url.clone(),
        config.connect_url.clone(),
    ));
    let queue_submission_path = config.state_dir.join("queue-idempotency.json");
    let queue_submissions =
        match BridgeQueueService::load_submission_store(&queue_submission_path).await {
            Ok(state) => state,
            Err(error) => {
                eprintln!("{error}");
                backend.shutdown().await;
                std::process::exit(1);
            }
        };
    let queue = BridgeQueueService::with_submission_store(
        backend.clone(),
        hub.clone(),
        Some(queue_submission_path),
        queue_submissions,
    );

    let project_label = config
        .workdir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "DapperCode".to_string());
    let push = PushService::load(&config.state_dir, project_label, metrics.clone()).await;
    let _push_event_loop = push.spawn_event_loop_with_queue(&hub, Some(queue.clone()));
    let operation_dedupe_path = config.state_dir.join("operation-idempotency.json");
    let operation_dedupe = match load_operation_dedupe(&operation_dedupe_path).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("{error}");
            backend.shutdown().await;
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        config: config.clone(),
        path_policy,
        started_at: Instant::now(),
        hub,
        backend,
        queue,
        operation_dedupe: Arc::new(Mutex::new(operation_dedupe)),
        thread_create_actor: Arc::new(Mutex::new(())),
        thread_fork_actor: Arc::new(Mutex::new(())),
        approval_resolution_actor: Arc::new(Mutex::new(())),
        operation_dedupe_path,
        operation_dedupe_dirty: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        thread_list_streams: Arc::new(Mutex::new(HashMap::new())),
        git,
        preview,
        push,
        ws_global_in_flight: Arc::new(Semaphore::new(config.ws_limits.global_in_flight)),
        metrics,
    });

    let app = build_bridge_router(state.clone());
    let preview_app = build_preview_router(state.clone());

    let preview_bind_addr = format!("{}:{}", config.preview_host, config.preview_port);
    let preview_listener = match tokio::net::TcpListener::bind(&preview_bind_addr).await {
        Ok(listener) => {
            state.preview.set_available(true);
            Some(listener)
        }
        Err(error) => {
            eprintln!("browser preview disabled: failed to bind {preview_bind_addr}: {error}");
            None
        }
    };

    println!("rust-bridge listening on {bind_addr}");
    println!("bridge state directory: {}", config.state_dir.display());
    println!("attachment directory: {}", config.attachments_dir.display());
    if preview_listener.is_some() {
        println!("browser preview listening on {preview_bind_addr}");
    }
    if let Some(connect_url) = bridge_access_url(&config) {
        let bind_url = format!(
            "http://{}:{}",
            format_host_for_url(&config.host),
            config.port
        );
        if connect_url != bind_url {
            println!("bridge connect URL: {connect_url}");
        }
    }
    maybe_print_pairing_qr(&config);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let preview_task = preview_listener.map(|listener| {
        let mut preview_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let serve_result = axum::serve(listener, preview_app)
                .with_graceful_shutdown(async move {
                    wait_for_shutdown_trigger(&mut preview_shutdown_rx).await;
                })
                .await;
            if let Err(error) = serve_result {
                eprintln!("browser preview server error: {error}");
            }
        })
    });
    let shutdown_backend = state.backend.clone();
    let shutdown_signal_tx = shutdown_tx.clone();
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let signal = tokio::select! {
                signal = wait_for_shutdown_signal() => signal,
                () = owner_watchdog::wait_for_owner_exit(owner_pid) => "owner exit",
            };
            eprintln!("shutdown signal received ({signal}), terminating managed backends");
            let _ = shutdown_signal_tx.send(true);
            shutdown_backend.shutdown().await;
        })
        .await;

    let _ = shutdown_tx.send(true);
    state.backend.shutdown().await;
    if let Some(task) = preview_task {
        let _ = task.await;
    }

    if let Err(error) = serve_result {
        eprintln!("server error: {error}");
        std::process::exit(1);
    }
}

async fn bind_then_start_backend<T, Start, StartFuture>(
    host: &str,
    port: u16,
    start_backend: Start,
) -> Result<(String, tokio::net::TcpListener, T), String>
where
    Start: FnOnce() -> StartFuture,
    StartFuture: Future<Output = Result<T, String>>,
{
    let bind_addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|error| format!("failed to bind {bind_addr}: {error}"))?;
    let backend = start_backend().await?;
    Ok((bind_addr, listener, backend))
}
