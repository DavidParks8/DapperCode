mod full_audio_validation {
    use super::*;
    use crate::phone_call::audio::{decode_mulaw, mean_abs_pcm};
    use futures_util::StreamExt;
    use std::{fs, path::PathBuf};

    const STIMULUS: &str = "Corner Bistro opens at nine and closes at five today.";
    const STIMULUS_FILE: &str = "full-audio-stimulus.pcm";
    const ROUND_TIMEOUT: Duration = Duration::from_secs(180);
    const AUDIO_ACTION_TIMEOUT: Duration = Duration::from_secs(45);
    const AUDIO_CLEANUP_TIMEOUT: Duration = Duration::from_secs(120);
    const FRAME_DURATION: Duration = Duration::from_millis(20);
    const SPEECH_THRESHOLD: i32 = 120;
    const MAX_STIMULUS_SAMPLES: usize = 24_000 * 30;
    const MAX_DIALOGUE_CAPTURE_BYTES: usize = 256 * 1024;
    const POST_DRAIN_GUARD: Duration = Duration::from_secs(2);

    #[test]
    #[ignore = "converts scenario-owned PCM using the production telephone audio path"]
    fn local_intelligibility_telephone_conversion() {
        let directory = fs::canonicalize(
            std::env::var_os("DAPPERCODE_TEST_VOICE_AUDIO_DATA_DIR")
                .expect("scenario-owned audio directory is required"),
        )
        .expect("audio directory exists");
        let manifest: Vec<String> = serde_json::from_slice(
            &fs::read(directory.join("intelligibility-inputs.json")).expect("read audio manifest"),
        )
        .expect("manifest contains flat PCM filenames");
        assert!(!manifest.is_empty(), "at least one PCM input is required");
        for name in manifest {
            assert!(
                name.ends_with(".pcm")
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
                    && !name.starts_with('.'),
                "PCM input must have a flat, non-hidden filename"
            );
            let input = fs::canonicalize(directory.join(&name)).expect("PCM input exists");
            assert_eq!(input.parent(), Some(directory.as_path()));
            let bytes = fs::read(input).expect("read PCM input");
            assert!(
                !bytes.is_empty()
                    && bytes.len().is_multiple_of(2)
                    && bytes.len() <= MAX_STIMULUS_SAMPLES * 2,
                "PCM input must contain complete 24 kHz samples, bounded to thirty seconds"
            );
            let samples: Vec<i16> = bytes
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let mut downsampled = Vec::new();
            Downsampler24kTo8k::new().push_pcm24k_samples(&samples, &mut downsampled);
            let mut decoded = Vec::new();
            for chunk in downsampled.chunks(RTP_FRAME_SAMPLES) {
                let mut frame = [0; RTP_FRAME_SAMPLES];
                frame[..chunk.len()].copy_from_slice(chunk);
                decoded.extend(
                    encode_mulaw_frame_with_headroom(&frame)
                        .into_iter()
                        .map(decode_mulaw),
                );
            }
            let output = directory.join(name.replace(".pcm", "-telephone.wav"));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)
                .expect("telephone output must be new");
            std::io::Write::write_all(&mut file, &super::super::audio::encode_wav_8k_mono(&decoded))
                .expect("write complete telephone WAV");
            println!(
                "INTELLIGIBILITY_CONVERSION {}",
                json!({
                    "input": name,
                    "input_samples": samples.len(),
                    "telephone_samples": decoded.len(),
                    "frame_samples": RTP_FRAME_SAMPLES,
                    "path": "production FIR/headroom/PCMU encode/decode; final frame padded only",
                })
            );
        }
    }

    #[derive(Default)]
    struct OutputObservation {
        first_nonsilent: Option<Instant>,
        first_speech_energy: Option<Instant>,
        last_nonsilent: Option<Instant>,
        drained: Option<Instant>,
        callee_visible: Option<Instant>,
        assistant_visible: Option<Instant>,
        pcmu_packets: usize,
        nonsilent_packets: usize,
        in_call_controls: bool,
        terminal_card: Option<Value>,
        playback_completion_observed: bool,
        post_drain_guard_passed: bool,
        unexpected_late_audio_packets: usize,
        post_drain_guard_elapsed_us: Option<i64>,
        post_drain_guard_completion: Option<&'static str>,
    }

    struct InputTiming {
        speech_end: Instant,
        last_packet_sent: Instant,
        packets_stopped: Instant,
        max_pacing_lateness_us: u128,
    }

    #[derive(Default)]
    struct CleanupObservation {
        hangup_status: Option<HangupPhoneCallStatus>,
        bye_acknowledged: bool,
        final_snapshot: Option<PhoneCallSnapshot>,
        final_card: Option<Value>,
        report_observed: bool,
        errors: Vec<String>,
    }

    struct StageHttpCall {
        stage: &'static str,
        request_started: Instant,
        upstream_dispatched: Option<Instant>,
        headers_received: Option<Instant>,
        first_body_byte: Option<Instant>,
        completed: Option<Instant>,
        body_dropped: Option<Instant>,
        status: Option<u16>,
        content_type: Option<String>,
        request_bytes: usize,
        response_bytes: usize,
        expected_response_bytes: Option<u64>,
        failure: Option<&'static str>,
        error_detail: Option<String>,
        dialogue_response: Vec<u8>,
        dialogue_capture_truncated: bool,
    }

    struct StageBodyTrace {
        calls: Arc<StdMutex<Vec<StageHttpCall>>>,
        index: usize,
    }

    impl Drop for StageBodyTrace {
        fn drop(&mut self) {
            let mut calls = lock_unpoisoned(&self.calls);
            if calls[self.index].completed.is_none() {
                calls[self.index].body_dropped = Some(Instant::now());
            }
        }
    }

    #[derive(Clone)]
    struct StageForwarderState {
        upstream_base: String,
        http: reqwest::Client,
        calls: Arc<StdMutex<Vec<StageHttpCall>>>,
    }

    struct StageForwarder {
        config: VoicePipelineConfig,
        calls: Arc<StdMutex<Vec<StageHttpCall>>>,
        shutdown: CancellationToken,
        servers: Vec<JoinHandle<()>>,
    }

    impl StageForwarder {
        async fn start(config: &VoicePipelineConfig) -> Self {
            let calls = Arc::new(StdMutex::new(Vec::new()));
            let shutdown = CancellationToken::new();
            let http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(ROUND_TIMEOUT)
                .build()
                .expect("bounded observational HTTP client");
            let mut observed_config = config.clone();
            let mut bases = std::collections::HashMap::new();
            let mut servers = Vec::new();
            for source in [
                &config.stt_base_url,
                &config.llm_base_url,
                &config.tts_base_url,
            ] {
                let source = source.trim_end_matches('/');
                if bases.contains_key(source) {
                    continue;
                }
                let state = StageForwarderState {
                    upstream_base: source.to_string(),
                    http: http.clone(),
                    calls: Arc::clone(&calls),
                };
                let app = Router::new()
                    .route("/api/chat", post(forward_voice_stage))
                    .route("/v1/audio/transcriptions", post(forward_voice_stage))
                    .route("/v1/chat/completions", post(forward_voice_stage))
                    .route("/v1/audio/speech", post(forward_voice_stage))
                    .with_state(state);
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind run-owned observational forwarder");
                let address = listener.local_addr().expect("forwarder address");
                let stopped = shutdown.clone();
                servers.push(tokio::spawn(async move {
                    axum::serve(listener, app)
                        .with_graceful_shutdown(stopped.cancelled_owned())
                        .await
                        .expect("observational forwarder serves real responses");
                }));
                let _ = bases.insert(source.to_string(), format!("http://{address}/v1"));
            }
            observed_config.stt_base_url = bases[config.stt_base_url.trim_end_matches('/')].clone();
            observed_config.llm_base_url = bases[config.llm_base_url.trim_end_matches('/')].clone();
            observed_config.tts_base_url = bases[config.tts_base_url.trim_end_matches('/')].clone();
            Self {
                config: observed_config,
                calls,
                shutdown,
                servers,
            }
        }

        async fn stop(mut self) -> Vec<String> {
            let mut errors = Vec::new();
            self.shutdown.cancel();
            for server in &mut self.servers {
                match timeout(AUDIO_ACTION_TIMEOUT, &mut *server).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => errors.push(format!("forwarder task failed: {error}")),
                    Err(_) => {
                        errors.push("forwarder graceful shutdown exceeded 45 seconds".to_string());
                        server.abort();
                        let _ = server.await;
                    }
                }
            }
            errors
        }
    }

    fn strip_hop_headers(headers: &mut axum::http::HeaderMap) {
        if let Some(connection) = headers.get(axum::http::header::CONNECTION).cloned() {
            if let Ok(names) = connection.to_str() {
                for name in names.split(',').map(str::trim) {
                    headers.remove(name);
                }
            }
        }
        for name in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "host",
        ] {
            headers.remove(name);
        }
    }

    fn forwarder_failure(
        calls: &StdMutex<Vec<StageHttpCall>>,
        index: usize,
        boundary: &'static str,
        detail: &str,
    ) -> Response {
        {
            let mut calls = lock_unpoisoned(calls);
            calls[index].failure = Some(boundary);
            calls[index].error_detail = Some(diagnostic_text(detail));
        }
        Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::from(
                "test-only stage observer could not forward the real request",
            ))
            .expect("bounded observational error response")
    }

    async fn forward_voice_stage(
        State(state): State<StageForwarderState>,
        request: axum::extract::Request,
    ) -> Response {
        let (mut parts, body) = request.into_parts();
        let (stage, endpoint) = match parts.uri.path() {
            "/v1/audio/transcriptions" => ("stt", "audio/transcriptions"),
            "/v1/chat/completions" => ("dialogue", "chat/completions"),
            "/v1/audio/speech" => ("tts", "audio/speech"),
            "/api/chat" => ("preload", ""),
            _ => unreachable!("only explicit voice routes are registered"),
        };
        let index = {
            let mut calls = lock_unpoisoned(&state.calls);
            let index = calls.len();
            calls.push(StageHttpCall {
                stage,
                request_started: Instant::now(),
                upstream_dispatched: None,
                headers_received: None,
                first_body_byte: None,
                completed: None,
                body_dropped: None,
                status: None,
                content_type: None,
                request_bytes: 0,
                response_bytes: 0,
                expected_response_bytes: None,
                failure: None,
                error_detail: None,
                dialogue_response: Vec::new(),
                dialogue_capture_truncated: false,
            });
            index
        };
        // Buffer only the bounded upload. SSE and PCM responses retain streaming/backpressure.
        let bytes = match timeout(
            Duration::from_secs(10),
            axum::body::to_bytes(body, 2 * 1024 * 1024),
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                return forwarder_failure(&state.calls, index, "request-body", &error.to_string());
            }
            Err(_) => {
                return forwarder_failure(
                    &state.calls,
                    index,
                    "request-body-timeout",
                    "request upload exceeded ten seconds",
                );
            }
        };
        let target = if stage == "preload" {
            reqwest::Url::parse(&state.upstream_base)
                .expect("validated upstream URL")
                .join("/api/chat")
                .expect("native preload URL")
                .to_string()
        } else {
            format!("{}/{endpoint}", state.upstream_base.trim_end_matches('/'))
        };
        strip_hop_headers(&mut parts.headers);
        {
            let mut calls = lock_unpoisoned(&state.calls);
            calls[index].request_bytes = bytes.len();
            calls[index].upstream_dispatched = Some(Instant::now());
        }
        let response = match state
            .http
            .request(parts.method, target)
            .headers(parts.headers)
            .body(bytes)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return forwarder_failure(
                    &state.calls,
                    index,
                    "upstream-send",
                    &http_error_diagnostic(&error.without_url()),
                );
            }
        };
        let status = response.status();
        let mut headers = response.headers().clone();
        strip_hop_headers(&mut headers);
        {
            let mut calls = lock_unpoisoned(&state.calls);
            calls[index].headers_received = Some(Instant::now());
            calls[index].status = Some(status.as_u16());
            calls[index].expected_response_bytes = response.content_length();
            calls[index].content_type = headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(diagnostic_text);
            if stage != "preload" && !status.is_success() {
                calls[index].failure = Some("upstream-http-status");
                calls[index].error_detail = Some(format!("upstream returned HTTP {status}"));
            }
        }
        let stream = futures_util::stream::unfold(
            (
                response.bytes_stream(),
                StageBodyTrace {
                    calls: Arc::clone(&state.calls),
                    index,
                },
            ),
            |(mut stream, trace)| async move {
                let index = trace.index;
                match stream.next().await {
                    Some(Ok(bytes)) => {
                        let framed_end;
                        {
                            let mut observed = lock_unpoisoned(&trace.calls);
                            if !bytes.is_empty() {
                                let _ = observed[index]
                                    .first_body_byte
                                    .get_or_insert_with(Instant::now);
                            }
                            observed[index].response_bytes += bytes.len();
                            if observed[index].stage == "dialogue" {
                                let remaining = MAX_DIALOGUE_CAPTURE_BYTES
                                    .saturating_sub(observed[index].dialogue_response.len());
                                observed[index]
                                    .dialogue_response
                                    .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                                observed[index].dialogue_capture_truncated |=
                                    bytes.len() > remaining;
                            }
                            framed_end =
                                observed[index]
                                    .expected_response_bytes
                                    .is_some_and(|expected| {
                                        expected
                                            == u64::try_from(observed[index].response_bytes)
                                                .expect("bounded response bytes")
                                    });
                        }
                        // A downstream Content-Length consumer need not poll again. Observe the
                        // actual upstream EOF before yielding the final framed chunk.
                        if framed_end {
                            match stream.next().await {
                                None => {
                                    lock_unpoisoned(&trace.calls)[index].completed =
                                        Some(Instant::now());
                                }
                                Some(Err(error)) => {
                                    let error = error.without_url();
                                    {
                                        let mut calls = lock_unpoisoned(&trace.calls);
                                        calls[index].failure = Some("upstream-body");
                                        calls[index].error_detail =
                                            Some(http_error_diagnostic(&error));
                                    }
                                    return Some((Err(error), (stream, trace)));
                                }
                                Some(Ok(extra)) => {
                                    let mut calls = lock_unpoisoned(&trace.calls);
                                    calls[index].response_bytes += extra.len();
                                    calls[index].failure = Some("upstream-content-length");
                                    calls[index].error_detail = Some(
                                        "upstream yielded bytes beyond its Content-Length"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                        Some((Ok::<_, reqwest::Error>(bytes), (stream, trace)))
                    }
                    Some(Err(error)) => {
                        let error = error.without_url();
                        {
                            let mut calls = lock_unpoisoned(&trace.calls);
                            calls[index].failure = Some("upstream-body");
                            calls[index].error_detail = Some(http_error_diagnostic(&error));
                        }
                        Some((Err(error), (stream, trace)))
                    }
                    None => {
                        let _ = lock_unpoisoned(&trace.calls)[index]
                            .completed
                            .get_or_insert_with(Instant::now);
                        None
                    }
                }
            },
        );
        let mut forwarded = Response::new(Body::from_stream(stream));
        *forwarded.status_mut() = status;
        *forwarded.headers_mut() = headers;
        forwarded
    }

    fn stage_metrics(
        calls: &StdMutex<Vec<StageHttpCall>>,
        speech_end: Option<Instant>,
        first_rtp: Option<Instant>,
    ) -> Value {
        Value::Array(
            lock_unpoisoned(calls)
                .iter()
                .enumerate()
                .map(|(index, call)| {
                    json!({
                        "index": index,
                        "stage": call.stage,
                        "status": call.status,
                        "response_content_type": call.content_type,
                        "failure": call.failure,
                        "error_detail": call.error_detail,
                        "request_bytes": call.request_bytes,
                        "response_bytes": call.response_bytes,
                        "expected_response_bytes": call.expected_response_bytes,
                        "dialogue_capture_truncated": call.dialogue_capture_truncated,
                        "body_completed": body_completed(call),
                        "body_eof_observed": call.completed.is_some(),
                        "consumer_dropped_before_eof": call.body_dropped.is_some(),
                        "content_length_satisfied": call.expected_response_bytes.map(|expected| expected == u64::try_from(call.response_bytes).expect("bounded response bytes")),
                        "body_state": if call.failure.is_some() {
                            "error"
                        } else if call.completed.is_some() {
                            "upstream-eof"
                        } else if call.body_dropped.is_some() {
                            "consumer-dropped-before-upstream-eof"
                        } else if call.first_body_byte.is_some() {
                            "streaming-without-observed-eof"
                        } else {
                            "awaiting-first-body-byte"
                        },
                        "speech_end_to_request_start_us": elapsed_us(Some(call.request_started), speech_end),
                        "request_upload_to_dispatch_us": elapsed_us(call.upstream_dispatched, Some(call.request_started)),
                        "upstream_dispatch_to_headers_us": elapsed_us(call.headers_received, call.upstream_dispatched),
                        "upstream_dispatch_to_first_body_byte_us": elapsed_us(call.first_body_byte, call.upstream_dispatched),
                        "upstream_dispatch_to_body_complete_us": if call.failure.is_none() { elapsed_us(call.completed, call.upstream_dispatched) } else { None },
                        "upstream_dispatch_to_consumer_drop_us": elapsed_us(call.body_dropped, call.upstream_dispatched),
                        "speech_end_to_first_body_byte_us": elapsed_us(call.first_body_byte, speech_end),
                        "first_body_byte_to_first_nonsilent_rtp_us": elapsed_us(first_rtp, call.first_body_byte),
                    })
                })
                .collect(),
        )
    }

    fn body_completed(call: &StageHttpCall) -> bool {
        call.completed.is_some()
            && call.failure.is_none()
            && call.expected_response_bytes.is_none_or(|expected| {
                expected == u64::try_from(call.response_bytes).expect("bounded response byte count")
            })
    }

    fn real_stages_succeeded(
        calls: &StdMutex<Vec<StageHttpCall>>,
        production_accepted_structured_turn: bool,
    ) -> bool {
        let calls = lock_unpoisoned(calls);
        ["stt", "dialogue", "tts"].iter().all(|stage| {
            let matching: Vec<_> = calls.iter().filter(|call| call.stage == *stage).collect();
            !matching.is_empty()
                && matching.iter().all(|call| {
                    call.status
                        .is_some_and(|status| (200..300).contains(&status))
                        && call.failure.is_none()
                        && call.first_body_byte.is_some()
                        && call.request_bytes > 0
                        && call.response_bytes > 0
                        && (body_completed(call)
                            || (*stage == "dialogue"
                                && call.body_dropped.is_some()
                                && production_accepted_structured_turn
                                && dialogue_call_evidence(call).structured_turn))
                })
        })
    }

    #[derive(Default)]
    struct DialogueEvidence {
        structured_turn: bool,
        model_text: String,
        action_names: Vec<String>,
        capture_truncated: bool,
    }

    fn json_strings(value: &Value, output: &mut String) {
        match value {
            Value::String(text) => {
                output.push_str(text);
                output.push(' ');
            }
            Value::Array(values) => {
                for value in values {
                    json_strings(value, output);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    json_strings(value, output);
                }
            }
            _ => {}
        }
    }

    fn dialogue_call_evidence(call: &StageHttpCall) -> DialogueEvidence {
        let mut evidence = DialogueEvidence {
            capture_truncated: call.dialogue_capture_truncated,
            ..DialogueEvidence::default()
        };
        let mut content = String::new();
        let mut tools = std::collections::BTreeMap::<u64, (String, String)>::new();
        for line in call.dialogue_response.split(|byte| *byte == b'\n') {
            let Some(data) = line.strip_prefix(b"data:") else {
                continue;
            };
            let Ok(chunk) = serde_json::from_slice::<Value>(data) else {
                continue;
            };
            let delta = &chunk["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                content.push_str(text);
            }
            if let Some(tool_calls) = delta["tool_calls"].as_array() {
                for tool in tool_calls {
                    let entry = tools
                        .entry(tool["index"].as_u64().unwrap_or(0))
                        .or_default();
                    if let Some(name) = tool["function"]["name"].as_str() {
                        entry.0.push_str(name);
                    }
                    if let Some(arguments) = tool["function"]["arguments"].as_str() {
                        entry.1.push_str(arguments);
                    }
                }
            }
        }
        if let Ok(value) = serde_json::from_str::<Value>(content.trim()) {
            if value.is_object() {
                evidence.structured_turn = true;
                if let Some(decision) = value["decision"].as_str() {
                    evidence.action_names.push(decision.to_string());
                }
                json_strings(&value, &mut evidence.model_text);
            }
        }
        let mut incomplete_tool = false;
        for (name, arguments) in tools.into_values() {
            match serde_json::from_str::<Value>(&arguments) {
                Ok(value) if !name.is_empty() && value.is_object() => {
                    evidence.structured_turn = true;
                    evidence.action_names.push(name);
                    json_strings(&value, &mut evidence.model_text);
                }
                _ => incomplete_tool = true,
            }
        }
        evidence.structured_turn &= !evidence.capture_truncated && !incomplete_tool;
        evidence
    }

    fn dialogue_evidence(calls: &StdMutex<Vec<StageHttpCall>>) -> DialogueEvidence {
        let mut evidence = DialogueEvidence::default();
        for call in lock_unpoisoned(calls)
            .iter()
            .filter(|call| call.stage == "dialogue")
        {
            let call = dialogue_call_evidence(call);
            evidence.structured_turn |= call.structured_turn;
            evidence.capture_truncated |= call.capture_truncated;
            evidence.action_names.extend(call.action_names);
            evidence.model_text.push_str(&call.model_text);
            evidence.model_text.push(' ');
        }
        evidence
    }

    fn assistant_response_checks(
        snapshot: &PhoneCallSnapshot,
        dialogue: &DialogueEvidence,
    ) -> Value {
        let speech = snapshot
            .transcript
            .iter()
            .filter(|entry| entry.speaker == TranscriptSpeaker::Assistant)
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let response = speech.to_ascii_lowercase();
        let tokens = words(&response);
        let bound_hours = critical_values(&response);
        let hours_understood = (bound_hours["opening_time"] == true
            && bound_hours["closing_time"] == true)
            || tokens.iter().enumerate().any(|(index, token)| {
                token == "nine"
                    && tokens[index + 1..]
                        .iter()
                        .take(7)
                        .enumerate()
                        .any(|(offset, token)| {
                            token == "five"
                                && tokens[index + 1..index + 1 + offset]
                                    .iter()
                                    .any(|token| matches!(token.as_str(), "to" | "until"))
                        })
            });
        let forbidden_commitments = [
            "i booked",
            "i have booked",
            "i've booked",
            "we booked",
            "i reserved",
            "i've reserved",
            "reservation is confirmed",
            "i purchased",
            "i paid",
            "i'll pay",
            "i will pay",
            "i'll order",
            "i will order",
            "i promise",
            "i commit",
            "i'll be there",
            "i will be there",
            "we will be there",
        ];
        let no_invented_commitment = !forbidden_commitments
            .iter()
            .any(|phrase| response.contains(phrase))
            && !dialogue.action_names.iter().any(|name| {
                ["book", "reserv", "purchas", "payment", "order"]
                    .iter()
                    .any(|part| name.to_ascii_lowercase().contains(part))
            });
        let closing = ["thank", "thanks", "bye", "goodbye"]
            .iter()
            .any(|closing| tokens.iter().any(|word| word == closing))
            || response.contains("that's all")
            || dialogue.action_names.iter().any(|name| name == "end_call");
        let appropriate_listen = !snapshot.on_hold
            && dialogue.action_names.iter().any(|name| name == "wait_silently")
            && hours_understood;
        let objective_fulfilled_or_appropriate_listen =
            hours_understood && (closing || appropriate_listen);
        let uninterrupted = !speech.contains(INTERRUPTED_MARKER);
        json!({
            "passed": !speech.is_empty() && hours_understood && no_invented_commitment
                && objective_fulfilled_or_appropriate_listen && uninterrupted,
            "hours_understood": hours_understood,
            "no_invented_commitment": no_invented_commitment,
            "objective_fulfilled_or_appropriate_listen": objective_fulfilled_or_appropriate_listen,
            "appropriate_listen": appropriate_listen,
            "assistant_transcript_uninterrupted": uninterrupted,
            "assistant_speech_word_count": words(&speech).len(),
            "assistant_speech_excerpt": truncate_utf8_bytes(&speech, 512).0,
            "model_output_excerpt": truncate_utf8_bytes(&dialogue.model_text, 512).0,
            "model_action_names": dialogue.action_names,
            "structured_response_observed": dialogue.structured_turn,
            "evidence_source": "hours and commitments use assistant-only spoken transcript; structured model output is used only for action validation/diagnostics",
            "limitations": "strict hours-case lexical/action checks, not a general semantic or human-preference evaluation; factual readback must be audible speech, not hidden structured metadata",
        })
    }

    fn metric(value: Value) {
        println!("AUDIO_METRIC {value}");
    }

    fn diagnostic_text(text: &str) -> String {
        let (mut text, _) = truncate_utf8_bytes(text, 4_096);
        for variable in [
            "DAPPERCODE_TEST_VOICE_STT_BASE_URL",
            "DAPPERCODE_TEST_VOICE_LLM_BASE_URL",
            "DAPPERCODE_TEST_VOICE_TTS_BASE_URL",
            "DAPPERCODE_TEST_VOICE_AUDIO_DATA_DIR",
        ] {
            if let Ok(value) = std::env::var(variable) {
                if !value.is_empty() {
                    text = text.replace(&value, "<run-owned-resource>");
                }
            }
        }
        text
    }

    fn http_error_diagnostic(error: &reqwest::Error) -> String {
        use std::error::Error;
        let summary = format!(
            "timeout={} connect={} body={} decode={} request={}",
            error.is_timeout(),
            error.is_connect(),
            error.is_body(),
            error.is_decode(),
            error.is_request(),
        );
        let mut detail = format!("{summary}: {error}");
        let mut source = error.source();
        for _ in 0..4 {
            let Some(cause) = source else { break };
            detail.push_str(&format!("; caused by: {cause}"));
            source = cause.source();
        }
        diagnostic_text(&detail)
    }

    fn production_state(snapshot: &PhoneCallSnapshot) -> Value {
        json!({
            "status": snapshot.status,
            "on_hold": snapshot.on_hold,
            "ended_at_present": snapshot.ended_at.is_some(),
            "end_reason": snapshot.end_reason.as_deref().map(diagnostic_text),
            "outcome_summary": snapshot.outcome_summary.as_deref().map(diagnostic_text),
            "transcript_entries": snapshot.transcript.len(),
        })
    }

    fn elapsed_us(later: Option<Instant>, earlier: Option<Instant>) -> Option<i64> {
        let (later, earlier) = (later?, earlier?);
        if let Some(duration) = later.checked_duration_since(earlier) {
            Some(i64::try_from(duration.as_micros()).expect("bounded duration"))
        } else {
            Some(
                -i64::try_from(earlier.duration_since(later).as_micros())
                    .expect("bounded duration"),
            )
        }
    }

    fn words(text: &str) -> Vec<String> {
        text.split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(|word| match word.to_ascii_lowercase().as_str() {
                "9" => "nine".to_string(),
                "5" => "five".to_string(),
                other => other.to_string(),
            })
            .collect()
    }

    fn word_error_basis_points(actual: &str) -> u64 {
        let reference = words(STIMULUS);
        let actual = words(actual);
        let mut previous: Vec<usize> = (0..=actual.len()).collect();
        for (row, expected) in reference.iter().enumerate() {
            let mut current = vec![row + 1];
            for (column, observed) in actual.iter().enumerate() {
                current.push(
                    (previous[column + 1] + 1)
                        .min(current[column] + 1)
                        .min(previous[column] + usize::from(expected != observed)),
                );
            }
            previous = current;
        }
        u64::try_from(previous[actual.len()] * 10_000 / reference.len())
            .expect("bounded word count")
    }

    fn critical_values(text: &str) -> Value {
        let tokens = words(text);
        let opening = tokens.iter().position(|word| word.starts_with("open"));
        let closing = tokens.iter().position(|word| word.starts_with("clos"));
        let time_after = |action: Option<usize>, time: &str| {
            action.is_some_and(|start| {
                tokens[start + 1..]
                    .iter()
                    .take_while(|word| !word.starts_with("open") && !word.starts_with("clos"))
                    .any(|word| word == time)
            })
        };
        json!({
            "callee_name": tokens.iter().any(|word| word == "bistro"),
            "opening_time": time_after(opening, "nine"),
            "closing_time": time_after(closing, "five"),
            "opening_action": opening.is_some(),
            "closing_action": closing.is_some(),
        })
    }

    async fn stimulus_pcm(client: &VoicePipelineClient, cold: bool) -> (Vec<i16>, bool) {
        let cache = std::env::var_os("DAPPERCODE_TEST_VOICE_AUDIO_DATA_DIR").map(|directory| {
            fs::canonicalize(PathBuf::from(directory))
                .expect("scenario-owned data directory exists")
                .join(STIMULUS_FILE)
        });
        if let Some(file) = &cache {
            match fs::read(file) {
                Ok(bytes) => {
                    assert!(
                        !bytes.is_empty()
                            && bytes.len() % 2 == 0
                            && bytes.len() <= MAX_STIMULUS_SAMPLES * 2,
                        "bounded scenario-owned PCM fixture"
                    );
                    return (
                        bytes
                            .chunks_exact(2)
                            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                            .collect(),
                        true,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("cannot read scenario-owned PCM: {error}"),
            }
        }
        assert!(
            !cold,
            "cold rounds require the previously generated run-owned PCM fixture; do not warm TTS first"
        );
        let mut pcm = Vec::new();
        let cancel = CancellationToken::new();
        timeout(
            ROUND_TIMEOUT,
            client.synthesize_speech_pcm24k(STIMULUS, &cancel, |samples| {
                assert!(
                    pcm.len() + samples.len() <= MAX_STIMULUS_SAMPLES,
                    "synthetic stimulus must not exceed thirty seconds"
                );
                pcm.extend_from_slice(samples);
            }),
        )
        .await
        .expect("bounded synthetic TTS generation")
        .expect("production TTS generates the synthetic input");
        assert!(!pcm.is_empty(), "TTS returned real PCM");
        if let Some(file) = cache {
            use std::io::Write;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(file)
                .expect("create only the run-owned synthetic fixture");
            for sample in &pcm {
                output
                    .write_all(&sample.to_le_bytes())
                    .expect("write run-owned PCM");
            }
        }
        (pcm, false)
    }

    fn add_noise(samples: &mut [i16], snr_db: Option<u32>, seed: u32) -> Value {
        let signal_energy: u64 = samples
            .iter()
            .map(|sample| {
                let magnitude = u64::from(sample.unsigned_abs());
                magnitude * magnitude
            })
            .sum();
        let Some(snr_db) = snr_db else {
            return json!({"requested_snr_db": null, "noise_energy": 0});
        };
        let ratio_milli = match snr_db {
            30 => 31_623_u64,
            20 => 10_000,
            10 => 3_162,
            _ => panic!("controlled noise levels are 30, 20, or 10 dB SNR"),
        };
        let rms = (signal_energy / u64::try_from(samples.len()).expect("bounded input")).isqrt();
        let peak = i64::try_from(rms * 1_732 / ratio_milli).expect("bounded noise amplitude");
        let mut state = seed.max(1);
        let mut noise_energy = 0_u64;
        let mut clipped_samples = 0_usize;
        for sample in samples {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let uniform = i64::from(state & 0xFFFF) - 32_768;
            let noise = uniform * peak / 32_768;
            let noisy = i64::from(*sample) + noise;
            let clipped = noisy.clamp(i64::from(i16::MIN), i64::from(i16::MAX));
            clipped_samples += usize::from(clipped != noisy);
            let actual_noise = clipped - i64::from(*sample);
            noise_energy += actual_noise.unsigned_abs().pow(2);
            *sample = i16::try_from(clipped).expect("clamped PCM sample");
        }
        json!({
            "requested_snr_db": snr_db,
            "signal_energy": signal_energy,
            "noise_energy": noise_energy,
            "clipped_samples": clipped_samples,
            "seed": seed,
            "injection": "uniform deterministic 8kHz noise before production PCMU headroom encoding",
        })
    }

    async fn inject_pcmu(
        rtp: &UdpSocket,
        destination: SocketAddr,
        frames: &[[u8; RTP_FRAME_SAMPLES]],
        last_speech_sample: usize,
        seq: &mut u16,
        ts: &mut u32,
    ) -> InputTiming {
        let start = tokio::time::Instant::now();
        let mut max_pacing_lateness_us = 0;
        let mut last_packet_sent = Instant::now();
        for (index, frame) in frames.iter().enumerate() {
            let scheduled = start
                + FRAME_DURATION * u32::try_from(index).expect("bounded stimulus frame count");
            tokio::time::sleep_until(scheduled).await;
            let packet =
                build_rtp_packet(index == 0, PCMU_PAYLOAD_TYPE, *seq, *ts, 0x1122_3344, frame);
            rtp.send_to(&packet, destination)
                .await
                .expect("inject isolated loopback RTP");
            last_packet_sent = Instant::now();
            max_pacing_lateness_us = max_pacing_lateness_us.max(
                last_packet_sent
                    .saturating_duration_since(scheduled.into_std())
                    .as_micros(),
            );
            *seq = seq.wrapping_add(1);
            *ts = ts.wrapping_add(u32::try_from(RTP_FRAME_SAMPLES).expect("frame size"));
        }
        let sample_offset = last_speech_sample % RTP_FRAME_SAMPLES + 1;
        let speech_end = last_packet_sent
            + Duration::from_micros(u64::try_from(sample_offset).expect("frame offset") * 125);
        tokio::time::sleep_until(tokio::time::Instant::from_std(
            last_packet_sent + FRAME_DURATION,
        ))
        .await;
        InputTiming {
            speech_end,
            last_packet_sent,
            packets_stopped: Instant::now(),
            max_pacing_lateness_us,
        }
    }

    fn card_has_hangup(params: &Value) -> bool {
        params["actions"]
            .as_array()
            .is_some_and(|actions| actions.iter().any(|action| action["id"] == "hangup"))
    }

    fn card_contains(params: &Value, text: &str) -> bool {
        params["blocks"].as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block["markdown"]
                    .as_str()
                    .is_some_and(|markdown| markdown.contains(text))
            })
        })
    }

    fn terminal_card(params: &Value) -> bool {
        params["dismissible"] == true && !card_has_hangup(params)
    }

    fn terminal_status(status: PhoneCallStatus) -> bool {
        matches!(
            status,
            PhoneCallStatus::Completed
                | PhoneCallStatus::Cancelled
                | PhoneCallStatus::Failed
                | PhoneCallStatus::NotFound
        )
    }

    async fn acknowledge_trunk_bye(
        sip: &UdpSocket,
        dialog: &MockSipDialog,
        packet: &[u8],
        peer: SocketAddr,
    ) -> Result<bool, String> {
        if peer != dialog.client_sip_addr {
            return Err("cleanup received SIP from an unexpected peer".to_string());
        }
        let text = std::str::from_utf8(packet).map_err(|error| error.to_string())?;
        if !text.starts_with("BYE ") {
            return Ok(false);
        }
        let header = |prefix: &str| {
            text.lines()
                .find_map(|line| {
                    let head = line.get(..prefix.len())?;
                    head.eq_ignore_ascii_case(prefix)
                        .then(|| line[prefix.len()..].trim().to_string())
                })
                .ok_or_else(|| format!("cleanup BYE is missing {prefix}"))
        };
        let via = header("Via:")?;
        let cseq = header("CSeq:")?;
        let response = format!(
            "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {}\r\nTo: {};tag=uas1\r\nCall-ID: {}\r\nCSeq: {cseq}\r\nContent-Length: 0\r\n\r\n",
            dialog.from, dialog.to, dialog.call_id
        );
        sip.send_to(response.as_bytes(), peer)
            .await
            .map_err(|error| error.to_string())?;
        Ok(true)
    }

    async fn cleanup_audio_call(
        call: &mut TrunkCall,
        observed_terminal_card: Option<Value>,
    ) -> CleanupObservation {
        let mut observed = CleanupObservation {
            final_card: observed_terminal_card,
            ..CleanupObservation::default()
        };
        let deadline = tokio::time::Instant::now() + AUDIO_CLEANUP_TIMEOUT;
        let hangup = timeout(
            AUDIO_ACTION_TIMEOUT,
            call.service.hangup_phone_call(TRUNK_OWNER, &call.call_id),
        );
        tokio::pin!(hangup);
        let mut hangup_pending = true;
        let mut notifications_open = true;
        let mut report_pending = true;
        let mut sip_open = true;
        let mut packet = vec![0_u8; 65_535];
        let mut status_poll = tokio::time::interval(Duration::from_millis(100));
        status_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => {
                    observed.errors.push("audio cleanup exceeded 120 seconds".to_string());
                    break;
                }
                result = &mut hangup, if hangup_pending => {
                    hangup_pending = false;
                    match result {
                        Ok(Ok(result)) => observed.hangup_status = Some(result.status),
                        Ok(Err(error)) => observed.errors.push(format!("hangup failed: {}", diagnostic_text(&error.to_string()))),
                        Err(_) => observed.errors.push("audio hangup exceeded 45 seconds".to_string()),
                    }
                }
                result = call.sip.recv_from(&mut packet), if sip_open => {
                    match result {
                        Ok((length, peer)) => {
                            let reply_deadline = deadline.min(tokio::time::Instant::now() + AUDIO_ACTION_TIMEOUT);
                            match tokio::time::timeout_at(
                                reply_deadline,
                                acknowledge_trunk_bye(&call.sip, &call.dialog, &packet[..length], peer),
                            ).await {
                                Ok(Ok(acknowledged)) => observed.bye_acknowledged |= acknowledged,
                                Ok(Err(error)) => observed.errors.push(diagnostic_text(&error)),
                                Err(_) => observed.errors.push("audio BYE acknowledgement exceeded its deadline".to_string()),
                            }
                        }
                        Err(error) => {
                            sip_open = false;
                            observed.errors.push(format!("cleanup SIP receive failed: {error}"));
                        }
                    }
                }
                message = call.notifications.recv(), if notifications_open => {
                    match message {
                        Some(Message::Text(text)) => match serde_json::from_str::<Value>(text.as_str()) {
                            Ok(notification) => {
                                if notification["method"] == "bridge/ui.update"
                                    && terminal_card(&notification["params"])
                                {
                                    observed.final_card = Some(notification["params"].clone());
                                }
                            }
                            Err(error) => observed.errors.push(format!("cleanup notification JSON failed: {error}")),
                        },
                        Some(_) => {}
                        None => {
                            notifications_open = false;
                            observed.errors.push("cleanup notification stream closed".to_string());
                        }
                    }
                }
                report = call.reports.recv(), if report_pending => {
                    report_pending = false;
                    observed.report_observed = report.is_some_and(|report| {
                        report.turn_start["input"][0]["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                    });
                    if !observed.report_observed {
                        observed.errors.push("post-call report was missing or empty".to_string());
                    }
                }
                _ = status_poll.tick() => {}
            }
            match call.service.get_phone_call(TRUNK_OWNER, &call.call_id) {
                Ok(snapshot) => observed.final_snapshot = Some(snapshot),
                Err(error) => {
                    let detail = format!(
                        "cleanup snapshot failed: {}",
                        diagnostic_text(&error.to_string())
                    );
                    if !observed.errors.contains(&detail) {
                        observed.errors.push(detail);
                    }
                }
            }
            if !hangup_pending
                && call.service.live_work_count() == 0
                && observed
                    .final_snapshot
                    .as_ref()
                    .is_some_and(|snapshot| terminal_status(snapshot.status))
                && observed.final_card.is_some()
                && !report_pending
            {
                break;
            }
        }
        observed
    }

    async fn observe_output(
        rtp: &UdpSocket,
        expected_peer: SocketAddr,
        notifications: &mut ClientOutboxReceiver,
        service: &PhoneCallService,
        call_id: &str,
        observed: &mut OutputObservation,
        http_calls: &StdMutex<Vec<StageHttpCall>>,
    ) -> Result<(), String> {
        let mut packet = [0_u8; 2048];
        let mut quiet_frames = 0_usize;
        let mut guard_started = None;
        let mut status_poll = tokio::time::interval(Duration::from_millis(100));
        status_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                result = rtp.recv_from(&mut packet) => {
                    let (length, peer) = result.map_err(|error| format!("output RTP receive failed: {error}"))?;
                    let received = Instant::now();
                    if peer != expected_peer {
                        return Err("output RTP received from unexpected peer".to_string());
                    }
                    let parsed = parse_rtp_packet(&packet[..length]).ok_or("invalid output RTP framing")?;
                    if parsed.payload_type != PCMU_PAYLOAD_TYPE {
                        continue;
                    }
                    if parsed.payload.len() != RTP_FRAME_SAMPLES {
                        return Err(format!("output PCMU payload has {} bytes instead of twenty milliseconds", parsed.payload.len()));
                    }
                    observed.pcmu_packets += 1;
                    let decoded: Vec<i16> = parsed.payload.iter().copied().map(decode_mulaw).collect();
                    if decoded.iter().any(|sample| *sample != 0) {
                        if guard_started.is_some() {
                            observed.unexpected_late_audio_packets += 1;
                            return Err("unexpected non-silent RTP after production-drained assistant transcript, completed STT/TTS bodies and 500ms quiet".to_string());
                        }
                        let _ = observed.first_nonsilent.get_or_insert(received);
                        observed.last_nonsilent = Some(received);
                        observed.nonsilent_packets += 1;
                        quiet_frames = 0;
                    } else if observed.first_nonsilent.is_some() {
                        quiet_frames += 1;
                    }
                    if mean_abs_pcm(&decoded) >= u32::try_from(SPEECH_THRESHOLD).expect("threshold") {
                        let _ = observed.first_speech_energy.get_or_insert(received);
                    }
                }
                message = notifications.recv() => {
                    let Message::Text(text) = message.ok_or("live notification stream closed")? else {
                        continue;
                    };
                    let notification: Value = serde_json::from_str(text.as_str()).map_err(|error| format!("live notification JSON failed: {error}"))?;
                    if notification["method"] != "bridge/ui.update" {
                        continue;
                    }
                    let params = &notification["params"];
                    let snapshot = service.get_phone_call(TRUNK_OWNER, call_id).map_err(|error| format!("live snapshot failed: {}", diagnostic_text(&error.to_string())))?;
                    if terminal_card(params) {
                        observed.terminal_card = Some(params.clone());
                    }
                    if params["subtitle"] == "In call" && card_has_hangup(params) {
                        observed.in_call_controls = true;
                    }
                    for entry in &snapshot.transcript {
                        if !card_contains(params, &entry.text) {
                            continue;
                        }
                        match entry.speaker {
                            TranscriptSpeaker::Callee => {
                                let _ = observed.callee_visible.get_or_insert_with(Instant::now);
                            }
                            TranscriptSpeaker::Assistant => {
                                let _ = observed.assistant_visible.get_or_insert_with(Instant::now);
                            }
                            _ => {}
                        }
                    }
                }
                _ = status_poll.tick() => {}
            }
            let snapshot = service
                .get_phone_call(TRUNK_OWNER, call_id)
                .map_err(|error| {
                    format!(
                        "live snapshot failed: {}",
                        diagnostic_text(&error.to_string())
                    )
                })?;
            let assistant_drained = snapshot.transcript.iter().any(|entry| {
                entry.speaker == TranscriptSpeaker::Assistant
                    && !entry.text.trim().is_empty()
                    && !entry.text.contains(INTERRUPTED_MARKER)
            });
            if guard_started.is_none()
                && observed.first_speech_energy.is_some()
                && observed.callee_visible.is_some()
                && observed.assistant_visible.is_some()
                && assistant_drained
                && quiet_frames >= 25
            {
                let accepted_structured_turn = dialogue_evidence(http_calls).structured_turn;
                if real_stages_succeeded(http_calls, accepted_structured_turn) {
                    observed.playback_completion_observed = true;
                    let completed = Instant::now();
                    observed.drained = Some(completed);
                    guard_started = Some(completed);
                }
            }
            if let Some(started) = guard_started {
                let now = Instant::now();
                if now.duration_since(started) >= POST_DRAIN_GUARD
                    || snapshot.status == PhoneCallStatus::Completed
                {
                    observed.post_drain_guard_elapsed_us = elapsed_us(Some(now), Some(started));
                    observed.post_drain_guard_passed = true;
                    observed.post_drain_guard_completion =
                        Some(if snapshot.status == PhoneCallStatus::Completed {
                            "production-call-completed-after-drain"
                        } else {
                            "two-second-quiet-observation-after-drain"
                        });
                    return Ok(());
                }
            }
            if terminal_status(snapshot.status) {
                return Err(format!(
                    "production call settled before full audio observation: {}",
                    production_state(&snapshot)
                ));
            }
        }
    }

    // Called once per sample by the isolated scenario; that scenario alone unloads cold models.
    #[tokio::test]
    #[ignore = "requires installed local speech/dialogue models and the isolated voice-full-audio-e2e scenario"]
    async fn local_full_audio_pipeline() {
        assert_eq!(
            std::env::var("DAPPERCODE_TEST_VOICE_AUDIO_ISOLATED").as_deref(),
            Ok("1"),
            "use only explicitly isolated loopback voice backends"
        );
        let base = std::env::var("DAPPERCODE_TEST_VOICE_LLM_BASE_URL")
            .expect("explicit isolated loopback voice base URL");
        let defaults = VoicePipelineConfig::default();
        let config = VoicePipelineConfig {
            stt_base_url: std::env::var("DAPPERCODE_TEST_VOICE_STT_BASE_URL")
                .unwrap_or_else(|_| base.clone()),
            llm_base_url: base.clone(),
            tts_base_url: std::env::var("DAPPERCODE_TEST_VOICE_TTS_BASE_URL").unwrap_or(base),
            stt_model: std::env::var("DAPPERCODE_TEST_VOICE_STT_MODEL")
                .unwrap_or(defaults.stt_model),
            llm_model: std::env::var("DAPPERCODE_TEST_VOICE_LLM_MODEL")
                .unwrap_or(defaults.llm_model),
            tts_model: std::env::var("DAPPERCODE_TEST_VOICE_TTS_MODEL")
                .unwrap_or(defaults.tts_model),
            tts_voice: std::env::var("DAPPERCODE_TEST_VOICE_TTS_VOICE")
                .unwrap_or(defaults.tts_voice),
        };
        let client =
            VoicePipelineClient::new(config.clone()).expect("validated loopback endpoints");
        let mode = std::env::var("DAPPERCODE_TEST_VOICE_AUDIO_MODE")
            .unwrap_or_else(|_| "warm".to_string());
        assert!(matches!(
            mode.as_str(),
            "warmup" | "warm" | "cold" | "noisy"
        ));
        let round = std::env::var("DAPPERCODE_TEST_VOICE_AUDIO_ROUND")
            .unwrap_or_else(|_| "1".to_string())
            .parse::<u32>()
            .expect("numeric sample index");
        let snr_db = std::env::var("DAPPERCODE_TEST_VOICE_AUDIO_SNR_DB")
            .ok()
            .filter(|value| !value.is_empty())
            .map(|value| value.parse::<u32>().expect("numeric controlled SNR"));
        let (pcm24k, cached_stimulus) = stimulus_pcm(&client, mode == "cold").await;
        let mut pcm8k = Vec::new();
        Downsampler24kTo8k::new().push_pcm24k_samples(&pcm24k, &mut pcm8k);
        let is_speech = |sample: &i16| i32::from(*sample).abs() >= SPEECH_THRESHOLD * 4;
        let first = pcm8k
            .iter()
            .position(is_speech)
            .expect("non-silent stimulus");
        let last = pcm8k.iter().rposition(is_speech).expect("speech end");
        let begin =
            first.saturating_sub(RTP_FRAME_SAMPLES * 2) / RTP_FRAME_SAMPLES * RTP_FRAME_SAMPLES;
        let mut speech = pcm8k[begin..=last].to_vec();
        let last_speech_sample = speech.len() - 1;
        let noise = add_noise(&mut speech, snr_db, 0x71AC_2026_u32.wrapping_add(round));
        let frames: Vec<[u8; RTP_FRAME_SAMPLES]> = speech
            .chunks(RTP_FRAME_SAMPLES)
            .map(|samples| {
                let mut frame = [0_i16; RTP_FRAME_SAMPLES];
                frame[..samples.len()].copy_from_slice(samples);
                encode_mulaw_frame_with_headroom(&frame)
            })
            .collect();
        let mock = MockVoiceState::new(Vec::new(), Vec::new(), 0);
        let forwarder = StageForwarder::start(&config).await;
        let mut options = TrunkCallOptions::new(ROUND_TIMEOUT, ROUND_TIMEOUT);
        options.voice_config = Some(forwarder.config.clone());
        options.connect_timeout = ROUND_TIMEOUT;
        options.objective = Some("Ask for the opening and closing hours, then repeat both times back to confirm.");
        let dial_started = Instant::now();
        let mut call = TrunkCall::connect(&mock, options).await;
        let connected = Instant::now();
        let recognition_priming_required =
            std::env::var("DAPPERCODE_TEST_VOICE_EXPECT_STT_PRIME").as_deref() == Ok("1");
        let recognition_primed_before_connection = lock_unpoisoned(&forwarder.calls).iter().any(|call| {
            call.stage == "stt" && body_completed(call)
                && call.completed.is_some_and(|completed| completed <= connected)
        });
        let speech_priming_required =
            std::env::var("DAPPERCODE_TEST_VOICE_EXPECT_TTS_PRIME").as_deref() == Ok("1");
        let speech_primed_before_connection = lock_unpoisoned(&forwarder.calls).iter().any(|call| {
            call.stage == "tts" && body_completed(call)
                && call.completed.is_some_and(|completed| completed <= connected)
        });
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        let mut observed = OutputObservation::default();
        let mut input = None;
        let media_result = timeout(ROUND_TIMEOUT, async {
            let ((), observation) = tokio::join!(
                async {
                    input = Some(
                        inject_pcmu(
                            &call.rtp,
                            call.dialog.client_rtp_addr,
                            &frames,
                            last_speech_sample,
                            &mut call.seq,
                            &mut call.ts,
                        )
                        .await,
                    );
                },
                observe_output(
                    &call.rtp,
                    call.dialog.client_rtp_addr,
                    &mut call.notifications,
                    &call.service,
                    &call.call_id,
                    &mut observed,
                    &forwarder.calls,
                ),
            );
            observation
        })
        .await;
        let snapshot = call.snapshot();
        let callee_text = snapshot
            .transcript
            .iter()
            .filter(|entry| entry.speaker == TranscriptSpeaker::Callee)
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let critical = critical_values(&callee_text);
        let correct = critical
            .as_object()
            .expect("critical value checks")
            .values()
            .all(|value| value == &json!(true));
        let speech_end = input.as_ref().map(|timing| timing.speech_end);
        let first_rtp_us = elapsed_us(observed.first_nonsilent, speech_end);
        let media_completed = matches!(&media_result, Ok(Ok(())));
        let observation_failure = match &media_result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(diagnostic_text(error)),
            Err(_) => Some("full audio observation exceeded 180 seconds".to_string()),
        };
        let dialogue = dialogue_evidence(&forwarder.calls);
        let assistant_checks = assistant_response_checks(&snapshot, &dialogue);
        let assistant_correct = assistant_checks["passed"] == true;
        let stages_succeeded = real_stages_succeeded(
            &forwarder.calls,
            dialogue.structured_turn && observed.playback_completion_observed,
        );
        let primary_failure = if snapshot.status == PhoneCallStatus::Failed {
            Some(format!(
                "production call failed before cleanup: {}",
                production_state(&snapshot)
            ))
        } else if observation_failure.is_some() {
            observation_failure.clone()
        } else if !correct {
            Some("STT did not preserve the synthetic callee and opening/closing values".to_string())
        } else if !assistant_correct {
            Some("assistant response/action checks failed independently of STT; see assistant_response_checks".to_string())
        } else if !first_rtp_us.is_some_and(|latency| latency >= 0) {
            Some("no non-silent output RTP observed after speech end".to_string())
        } else if !observed.in_call_controls {
            Some("live in-call status and hangup control were not observed".to_string())
        } else if !stages_succeeded {
            Some("a real voice HTTP stage failed; see recorded http_stages".to_string())
        } else if recognition_priming_required && !recognition_primed_before_connection {
            Some("recognition was not primed through its real endpoint before connection".to_string())
        } else if speech_priming_required && !speech_primed_before_connection {
            Some("speech synthesis was not primed through its real endpoint before connection".to_string())
        } else {
            None
        };
        let mut round_metric = json!({
            "kind": "round",
            "mode": mode,
            "round": round,
            "pipeline_completed": media_completed,
            "models": {"stt": config.stt_model, "dialogue": config.llm_model, "tts": config.tts_model},
            "cached_stimulus": cached_stimulus,
            "input_pcm24k_samples": pcm24k.len(),
            "input_rtp_packets": frames.len(),
            "inbound_trailing_silence_packets": 0,
            "input_last_speech_sample_offset": last_speech_sample % RTP_FRAME_SAMPLES,
            "input_speech_threshold_pcm8k": SPEECH_THRESHOLD,
            "speech_end_definition": "last above-threshold clean stimulus sample boundary, paced from actual final RTP send; 125us sample resolution",
            "first_nonsilent_definition": "first received PCMU RTP containing a decoded nonzero sample; not a text/token timestamp",
            "dial_to_connected_us": elapsed_us(Some(connected), Some(dial_started)),
            "speech_end_to_first_nonsilent_rtp_us": first_rtp_us,
            "speech_end_to_first_speech_energy_rtp_us": elapsed_us(observed.first_speech_energy, speech_end),
            "speech_end_to_live_callee_transcript_us": elapsed_us(observed.callee_visible, speech_end),
            "live_callee_transcript_to_first_nonsilent_rtp_us": elapsed_us(observed.first_nonsilent, observed.callee_visible),
            "first_nonsilent_to_drain_us": elapsed_us(observed.drained, observed.first_nonsilent),
            "last_nonsilent_to_drain_us": elapsed_us(observed.drained, observed.last_nonsilent),
            "last_input_packet_to_packets_stopped_us": elapsed_us(input.as_ref().map(|timing| timing.packets_stopped), input.as_ref().map(|timing| timing.last_packet_sent)),
            "max_input_pacing_lateness_us": input.as_ref().map(|timing| timing.max_pacing_lateness_us),
            "output_pcmu_packets": observed.pcmu_packets,
            "output_nonsilent_packets": observed.nonsilent_packets,
            "live_callee_transcript_observed": observed.callee_visible.is_some(),
            "live_assistant_transcript_observed": observed.assistant_visible.is_some(),
            "in_call_hangup_control_observed": observed.in_call_controls,
            "stt_critical_values": critical,
            "stt_critical_values_correct": correct,
            "stt_word_error_basis_points": word_error_basis_points(&callee_text),
            "http_stages": stage_metrics(&forwarder.calls, speech_end, observed.first_nonsilent),
            "http_stage_observation": "test-only loopback forwarding to unchanged real endpoints; streamed response bytes; body_completed requires observed upstream EOF without error and declared Content-Length integrity, not an SSE DONE marker; consumer cancellation is recorded separately",
            "noise": noise,
            "limitations": "synthetic TTS speech (phonon by default) is not representative of accents; no listening, prosody, or human-preference claim; cold unloads only scenario-owned Ollama models before dial, preserving production preloading; overridden providers are not unloaded",
        });
        if let Value::Object(details) = json!({
            "primary_failure_before_cleanup": primary_failure,
            "observation_failure": observation_failure,
            "production_state_before_cleanup": production_state(&snapshot),
            "audio_observation_timeout_seconds": ROUND_TIMEOUT.as_secs(),
            "cleanup_action_timeout_seconds": AUDIO_ACTION_TIMEOUT.as_secs(),
            "cleanup_total_timeout_seconds": AUDIO_CLEANUP_TIMEOUT.as_secs(),
            "assistant_response_checks": assistant_checks,
            "recognition_priming_required": recognition_priming_required,
            "recognition_primed_before_connection": recognition_primed_before_connection,
            "speech_priming_required": speech_priming_required,
            "speech_primed_before_connection": speech_primed_before_connection,
            "production_playback_completion_observed": observed.playback_completion_observed,
            "playback_completion_basis": "production accepted the assistant turn and committed its uninterrupted spoken transcript after RTP drain; successful STT/TTS HTTP EOF and declared Content-Length integrity are additionally required",
            "post_drain_guard_passed": observed.post_drain_guard_passed,
            "post_drain_guard_elapsed_us": observed.post_drain_guard_elapsed_us,
            "post_drain_guard_completion": observed.post_drain_guard_completion,
            "unexpected_late_audio_packets": observed.unexpected_late_audio_packets,
        }) {
            round_metric
                .as_object_mut()
                .expect("round metric object")
                .extend(details);
        }
        metric(round_metric);
        let cleanup = cleanup_audio_call(&mut call, observed.terminal_card.take()).await;
        let mocks_unused = mock.stt_requests.load(Ordering::SeqCst) == 0
            && mock.chat_requests.lock().await.is_empty()
            && mock.tts_requests.lock().await.is_empty();
        let stages_after_cleanup = Arc::clone(&forwarder.calls);
        let forwarder_shutdown_errors = forwarder.stop().await;
        let lifecycle_ok = cleanup.final_snapshot.as_ref().is_some_and(|settled| {
            settled.status == PhoneCallStatus::Completed
                && !settled.on_hold
                && settled.ended_at.is_some()
        }) && call.service.live_work_count() == 0
            && cleanup.final_card.as_ref().is_some_and(terminal_card)
            && cleanup.report_observed
            && cleanup.bye_acknowledged
            && mocks_unused
            && cleanup.errors.is_empty()
            && forwarder_shutdown_errors.is_empty();
        metric(json!({
            "kind": "lifecycle",
            "mode": mode,
            "round": round,
            "settled": lifecycle_ok,
            "primary_failure_before_cleanup": primary_failure,
            "final_status": cleanup.final_snapshot.as_ref().map(|snapshot| snapshot.status),
            "production_state_after_cleanup": cleanup.final_snapshot.as_ref().map(production_state),
            "cleanup_errors": cleanup.errors,
            "forwarder_shutdown_errors": forwarder_shutdown_errors,
            "mock_voice_endpoints_unused": mocks_unused,
            "real_stt_dialogue_tts_http_stages_succeeded": stages_succeeded,
            "hangup_status": cleanup.hangup_status,
            "trunk_bye_acknowledged": cleanup.bye_acknowledged,
            "post_call_report_observed": cleanup.report_observed,
            "terminal_card_observed": cleanup.final_card.is_some(),
            "final_hangup_control_removed": cleanup.final_card.as_ref().is_some_and(|card| !card_has_hangup(card)),
            "http_stages_after_cleanup": stage_metrics(&stages_after_cleanup, speech_end, observed.first_nonsilent),
        }));
        assert!(
            primary_failure.is_none(),
            "primary full-audio failure before cleanup: {}",
            primary_failure.as_deref().unwrap_or("none")
        );
        assert!(media_completed, "bounded full-audio pipeline completes");
        assert!(
            correct,
            "STT preserves the synthetic callee name and critical opening/closing values"
        );
        assert!(
            assistant_correct,
            "assistant independently understands the hours, invents no commitment, and fulfills the objective or listens appropriately"
        );
        assert!(
            first_rtp_us.is_some_and(|latency| latency >= 0),
            "first real non-silent RTP follows speech end"
        );
        assert!(
            observed.in_call_controls,
            "live status and hangup control are published"
        );
        assert!(
            stages_succeeded,
            "STT/TTS complete with upstream EOF and Content-Length integrity; dialogue completes or drops only after a production-accepted structured turn"
        );
        assert!(
            observed.playback_completion_observed
                && observed.post_drain_guard_passed
                && observed.unexpected_late_audio_packets == 0,
            "full production playback drains without interruption, HTTP truncation, or unexpected late audio before hangup"
        );
        assert!(
            lifecycle_ok,
            "status, controls, report, live-work accounting and real endpoints settle together; cleanup errors: {:?}; forwarder shutdown errors: {:?}",
            cleanup.errors,
            forwarder_shutdown_errors,
        );
    }
}
