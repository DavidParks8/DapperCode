# Native pinned TLS platform proof

This Stage 1 harness proves the native iOS-to-rustls mechanics needed by the future
`tailnetPinnedTls` transport. It does not enable that production mode or add pairing, enrollment,
device persistence, key rotation, desktop device UI, browser preview, or general mobile networking.
Production `tailnetPinnedTls` remains fail-closed.

## Security boundary

- Physical-device reachability is restricted to a concrete Tailscale address in
  `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. Only the explicitly labeled simulator path may bind
  loopback; wildcard and ordinary LAN binds are rejected.
- The proof server enables TLS 1.3 only and requires one self-signed client leaf. It sends an empty
  acceptable-CA list, disables session storage, emits zero TLS 1.3 tickets, disables early data,
  and disables half-RTT data.
- Client authorization is an exact base64url-without-padding SHA-256 hash of DER
  SubjectPublicKeyInfo. X.509 validity, purpose, curve, signature, and self-signature checks are
  wrapper hygiene, not authority.
- The rustls verifier advertises only `ECDSA_NISTP256_SHA256` and delegates TLS 1.3
  CertificateVerify to the ring provider. Its TLS 1.2 callback always rejects.
- Native iOS checks the exact server SPKI, one self-signed P-256/ECDSA-SHA256 leaf, validity,
  CA=false, digitalSignature, serverAuth, SAN/hostname, and self-signature before accepting
  `SecTrust`. A CA-signed chain is rejected even when its exact leaf pin is supplied.

The server is the isolated `pinned_tls_proof` Cargo binary. It does not use the production bridge
router or configuration. The iOS client is the `debugOnly` local Expo module
`dappercode-pinned-tls-proof`, so clean Expo prebuilds wire it reproducibly while release
configurations exclude it. The proof JavaScript is rooted at the dedicated
`PinnedTlsProofEntry.tsx` Debug harness; production `index.js` and `App.tsx` do not import any proof
source. A checked-in Expo config plugin gives proof builds a separate Swift compilation condition
that selects the embedded proof bundle directly, so an unrelated Metro listener cannot substitute
the production entry. Release builds do not define that condition.

## Exercised iOS target and dependencies

A clean Expo SDK 55 prebuild generates an iOS deployment target of **15.1** in both the Xcode
project and Podfile. The runner asserts both values before building.

The native wrapper path uses Apple Swift Certificates `1.19.3`, Swift Crypto `4.5.1`, and Swift
ASN.1 `1.7.1`. Swift Certificates wraps the real `SecKey` and delegates signing to
Security.framework; the proof does not hand-roll certificate DER or private-key operations.

On a physical iPhone, the key request is:

- Secure Enclave P-256 and permanent;
- `AfterFirstUnlockThisDeviceOnly`;
- access control containing only `.privateKeyUsage`; and
- non-interactive, with no user-presence, passcode, or biometric flag.

The harness verifies the persisted storage/access-control object, attempts and requires private-key
export to fail, and performs a signing operation without authentication UI. Simulator runs use an
explicitly labeled exportable software-Keychain P-256 fallback and can never pass the hardware gate.
No private key, Keychain persistent reference, device identifier, or bearer token enters JavaScript,
the report, logs, or the repository.

## Simulator proof

Run the full reproducible path:

```bash
npm run proof:pinned-tls:simulator
```

The command performs a clean Expo prebuild, installs Pods, asserts iOS 15.1, embeds the dedicated
proof entry in the Debug app without Metro, verifies that entry's marker in the built app, starts two
isolated rustls servers, and runs native HTTPS and WSS checks. It also proves:

- independent HTTPS and WSS TLS handshakes select the same `SecIdentity` when CA hints are empty;
- the rustls side accepted four TLS 1.3 handshakes with the configured client SPKI after real
  CertificateVerify checks;
- wrong server SPKI and wrong hostname are rejected;
- a CA-signed server substitution is rejected before its rustls handshake completes;
- renewal creates a new self-signed wrapper around the same key and preserves the SPKI;
- fresh HTTPS and WSS connections succeed after the induced simulator reconnect; and
- prompt evidence remains explicitly unobserved (`promptCount: null`,
  `promptCountSource: "simulatorNotObserved"`). Successful operations with authentication UI
  disabled are useful software evidence, but cannot satisfy the physical prompt gate.

The command writes a mode-0600 structured JSON report to the operating-system temporary directory.
A successful simulator run reports `softwareProofPassed: true`,
`mode: "simulatorSoftwareFallback"`, and `hardwareGatePassed: false`.

Focused automated checks are:

```bash
cargo test --locked --manifest-path services/rust-bridge/Cargo.toml pinned_tls_proof -- --test-threads=1
swift test --package-path apps/mobile/modules/dappercode-pinned-tls-proof --disable-sandbox
npm run proof:pinned-tls:release-isolation
```

The Rust suite rejects unknown pins, malformed/trailing DER, intermediates, expired and
not-yet-valid wrappers, missing/wrong usage, CA=true, wrong curves and signature algorithms, invalid
self-signatures, TLS 1.2 negotiation, and the TLS 1.2 signature callback. Its malicious handshake
presents certificate A while signing CertificateVerify with private key B. Replacing the provider
verification call with unconditional success makes that handshake succeed and the test fail.

The Swift policy suite covers valid wrapper/SPKI continuity plus wrong pin, validity, purpose,
CA=true, wrong curve, missing SAN, invalid self-signature, CA-signed substitution, and malformed DER.
The full simulator run additionally exercises Security.framework hostname evaluation and native
URLSession/WebSocket challenge handling.

The Release-isolation check generates a production Metro Release bundle and source map, verifies
that neither the unique proof marker nor any proof source enters that graph, and confirms a separate
proof-entry bundle does contain the marker. It then performs a clean iOS prebuild/Pod install and
Release simulator build, requiring the proof pod in Debug configuration while rejecting it from the
Release Pods configuration, generated app artifacts, native executable, and embedded bundle.

## Physical-iPhone gate

With an unlocked development iPhone connected, Tailscale active on both peers, and the host
MagicDNS name available:

```bash
npm run proof:pinned-tls:ios -- --device "<connected iPhone>" --tailnet-host "<host MagicDNS name>"
```

Pass `--development-team "<team ID>"` only when Xcode cannot infer signing, and
`--tailscale-ip "<host Tailscale IP>"` only when the local `tailscale` CLI cannot report it.

The command prepares the public client wrapper, starts the exact-pin rustls servers on the selected
Tailscale address, and relaunches the proof screen. The physical debug build uses its embedded
JavaScript bundle and does not expose a Metro listener. On the phone, tap **Run proof**, induce one
real network transition while Tailscale remains the reachability layer, return to the app, and
record whether any passcode, biometric, Keychain, or credential prompt appeared.

The report records the device OS version, iOS 15.1 target, hardware-backed status, private-key export
failure, verified storage/access control, HTTPS and WSS results, both empty-CA identity selections,
wrong-pin/hostname/CA-substitution rejection, renewal SPKI continuity, reconnect result, prompt
count, accepted server handshakes, TLS version, and disabled ticket/early-data state.

**Hard gate:** production pinned mode must remain unavailable until a supported physical iPhone
produces a report with every software item passing, `hardwareBacked: true`,
`privateKeyExportFailed: true`, `promptCount: 0`, and `hardwareGatePassed: true`.

## Current evidence

The latest local simulator run exercised iOS Simulator 26.5 with deployment target 15.1 and passed
the complete software matrix. The software key was correctly reported as non-hardware-backed and
exportable, so the hardware gate remained false.

No connected physical iPhone was available for this Stage 1 run. The physical-device gate is
**blocked, not passed**, and the pull request must remain draft.
