# Native iOS ATS Regression

From the repository root, with dependencies installed, Xcode selected, and the iOS 26.5
simulator runtime installed on an Apple Silicon Mac:

```sh
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-evidence.jsonl \
  apps/mobile/plugins/tests/native-ats.mjs
```

Use a new evidence filename each time. No prebuild or production bridge is needed.
The scenario reads the real app configuration with Expo `config --type introspect`, including
the registered plugin chain, without writing the native project. It builds one Swift executable
in the harness root and packages it with three ATS policies: permissive control, the old policy,
and the generated policy. Each has a separate bundle ID on a newly created iOS 26.5 simulator.

The control must upload successfully, the old policy must fail with `NSURLErrorDomain/-1022`
without reaching the receiver, and the generated policy must upload successfully twice across
fresh app launches. The generated dictionary must be exactly `{ NSAllowsArbitraryLoads: true }`:
fine-grained keys can override that setting. Removing the plugin or reintroducing an overriding
policy therefore fails the test, rather than silently testing a hard-coded fix.

The receiver binds only `127.0.0.1` on port 0. Native requests use `127.0.0.1.nip.io`, a real FQDN,
and send a multipart PNG with the attachment field names. The receiver checks the Host header,
method, path, content type, every multipart byte, and attempt/accept counts. The Swift app also
verifies UIKit can decode the PNG. No URLProtocol mock, request rewrite, hosts edit, custom DNS
delegate, or proxy is used. **External DNS is required** for nip.io to resolve to loopback; DNS
failure or rebinding protection fails the positive control, not a false-positive ATS assertion.
Localhost and `.local` names are deliberately avoided because the old policy allows local networking.

Commands, readiness, and assertions run through the local-e2e-validation harness. Native requests
have 15-second request and 20-second resource deadlines; launches allow 45 seconds, simulator boot
and compilation 120 seconds. Normal success and thrown failures shut down/delete only the owned
simulator, stop the owned receiver, and let the harness remove its run root. As with the existing
native paste harness, abrupt runner termination can leave the external simulator behind; its name
is the evidence run ID. Never clean up other simulators by name pattern.

Scope: real iOS URLSession/ATS enforcement, generated Expo ATS policy, and actual HTTP image
multipart transport. Expo fetch uses this URLSession layer, but this does **not** execute Expo JS,
Expo's multipart encoder, the production Rust attachment endpoint/authentication, clipboard
extraction, composer UI, or the installed production app. It is a native transport regression,
not full Expo application E2E.
