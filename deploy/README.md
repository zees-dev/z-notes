# Deploying z-notes (SPEC §10, phase 6)

```
browser (laptop / phone, on the tailnet)
   │  https://znotes.home.arpa   or   https://znotes.<tailnet>.ts.net
   ▼
Traefik (bundled with k3s) ── TLS from cert-manager's private CA
   ▼
Service znotes (ClusterIP :80)
   ▼
Deployment znotes — ONE replica, bun server/index.ts, :4700
   └── PVC znotes-vault mounted at /vault
        ├── *.md                      the notes (source of truth)
        └── .znotes/
             ├── settings.toml, vault.pub, identity.age   (committed)
             └── index.db{,-wal,-shm}                     (sqlite WAL, untracked)
```

**No app-level auth, by design** (SPEC §10, ticket 13): the cluster and the
tailnet are the perimeter. The only credential in the product is the vault
passphrase, and that guards the age identity, not the app. Consequence: do not
expose the Ingress to the public internet, and do not give the Service a
NodePort or LoadBalancer.

**TLS is not decoration.** SPEC §6 encrypts secrets in the browser with
WebCrypto, which only exists in a secure context. Over plain HTTP the app still
runs — degradation is required, not optional — but every secret block stays
armored and unlock is replaced by an explanatory badge.

## Files

| | |
|---|---|
| `Dockerfile` | production image. Build context is the **repo root**. |
| `../.dockerignore` | at the repo root because that is where the builder looks. |
| `k3s/00…50-*.yaml` | the deployment; apply with `kubectl apply -k deploy/k3s`. |
| `k3s/alt-ingressroute.yaml` | Traefik CRD form of the Ingress. Either/or. |
| `k3s/alt-tailscale-ingress.yaml` | Tailscale operator ingress — real cert, no trust step. |

Both `alt-*` files are excluded from `kustomization.yaml` on purpose; apply them
by hand if you want them.

---

## 1. Build the image

```sh
cd /path/to/z-notes            # context is the repo root, not deploy/
docker build -f deploy/Dockerfile -t z-notes:0.1.0 .
```

**Match the node's architecture.** A Mac builds `linux/arm64` by default, which
is right for a Raspberry Pi node and wrong for an x86 box. Be explicit:

```sh
docker buildx build --platform linux/arm64 -f deploy/Dockerfile -t z-notes:0.1.0 --load .
```

There is **no frontend build step**, on purpose. `server/index.ts` serves `app/` as
plain files (`APP_DIR = <repo>/app`), and the one thing that needs bundling —
the `age-encryption` browser module — is bundled by the server itself at boot,
in memory, at `/vendor/age.<hash>.js`. Running
`bun build ./app/index.html --outdir=dist` would emit a content-hashed tree at a
path the server never reads. `--compile` is also avoided: it reports
`import.meta.dir` as `/$bunfs/root`, which `server/index.ts` uses to locate `app/`,
`vendor/` and `bun.lock`. (The vault and DB are already immune — they come from
`$ZNOTES_VAULT`.)

## 2. Load it into k3s

No registry needed. Save, copy, import — on **every node that can run the pod**
(with one replica on an RWO local-path volume that is effectively one node):

```sh
docker save z-notes:0.1.0 | gzip > z-notes-0.1.0.tar.gz
scp z-notes-0.1.0.tar.gz <node>:/tmp/
ssh <node> 'sudo k3s ctr images import /tmp/z-notes-0.1.0.tar.gz && rm /tmp/z-notes-0.1.0.tar.gz'
ssh <node> 'sudo k3s ctr images ls | grep z-notes'
```

With a registry instead, push `<registry>/z-notes:0.1.0` and point kustomize at
it: `cd deploy/k3s && kustomize edit set image z-notes=<registry>/z-notes:0.1.0`.

`imagePullPolicy` is `IfNotPresent` — `Always` would chase a registry that does
not exist and sit in `ImagePullBackOff`.

## 3. Install cert-manager

```sh
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace --set crds.enabled=true
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
```

(`--set installCRDs=true` on cert-manager < 1.15. Or apply the release's
`cert-manager.yaml` directly.) Wait for the webhook to be Ready before step 5 —
applying `Certificate` objects before it is up fails with a webhook error.

## 4. Set your hostname

Three files carry `znotes.home.arpa`, and all three must agree with what you
type in the browser or you get a name-mismatch error that looks exactly like an
untrusted-CA error:

- `k3s/40-certificates.yaml` — `commonName` + `dnsNames`
- `k3s/50-ingress.yaml` — `tls[].hosts` and both `rules[].host`

`home.arpa` is the IETF-reserved name for local networks (RFC 8375); unlike
`.local` (mDNS) or an invented TLD it can never collide with a real
registration. Point it at the node:

```sh
echo "192.168.1.225  znotes.home.arpa" | sudo tee -a /etc/hosts   # or a LAN DNS record
```

If you also want the MagicDNS name on this certificate, uncomment the
`znotes.<tailnet>.ts.net` entries in both files (`tailscale status` prints your
tailnet name).

## 5. Apply

```sh
kubectl apply -k deploy/k3s
kubectl -n znotes rollout status deploy/znotes
kubectl -n znotes get certificate         # both should read READY=True
```

`znotes-ca` must go Ready before `znotes-tls` can — the second is signed by the
first. If `znotes-tls` is stuck, `kubectl -n znotes describe certificate
znotes-tls` names the reason.

## 6. Trust the CA

Export the **public** half only — the private key stays in the cluster:

```sh
kubectl -n znotes get secret znotes-ca -o jsonpath='{.data.tls\.crt}' \
  | base64 -d > znotes-ca.crt
```

- **macOS** — `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain znotes-ca.crt`
- **iOS / iPadOS** — AirDrop the file, install the profile in Settings, then the
  step everyone forgets: **Settings › General › About › Certificate Trust
  Settings** and switch the CA on. Without it Safari still refuses the site.
- **Linux** — `sudo cp znotes-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
- **Chrome/Chromium on Linux** (separate NSS store) —
  `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "z-notes local CA" -i znotes-ca.crt`
- **Firefox** (always its own store) — Settings › Privacy & Security › View
  Certificates › Authorities › Import, tick "identify websites".

Then open `https://znotes.home.arpa`. Confirm the secure context actually took:
the secrets UI should offer unlock rather than the degraded badge, and
`window.isSecureContext` in the console should be `true`.

The 90-day server certificate rotates on its own; you never repeat this step.

## 7. Reach it over Tailscale

Two paths. **They compose** — run both and use whichever the device can see.

**A — Tailscale on the k3s node** (simplest; keeps the private CA). Install
Tailscale on the node and `tailscale up`. Every tailnet device can now reach the
node's IP, so Traefik answers as long as the hostname resolves. Add the name to
each device's hosts file, or advertise the LAN as a subnet route
(`tailscale up --advertise-routes=192.168.1.0/24 --accept-dns=false`, then
approve it in the admin console) so your existing DNS keeps working remotely.
To use the MagicDNS name instead, add `znotes.<tailnet>.ts.net` to the
certificate's `dnsNames` **and** to the Ingress `rules`/`tls.hosts`.

**B — the Tailscale Kubernetes operator** (`k3s/alt-tailscale-ingress.yaml`).
The operator joins a proxy to your tailnet as a device and Tailscale issues a
**real, publicly-trusted** certificate for `znotes.<tailnet>.ts.net` — step 6
disappears entirely, including on phones. Requires MagicDNS and HTTPS
certificates enabled in the tailnet admin console, plus an OAuth client you
create there (nothing here ships a credential). Reachable only from the tailnet,
which is why A is still worth keeping for LAN access.

Either way the perimeter argument holds: the tailnet is the auth boundary. Keep
ACLs tight and do not enable Funnel — Funnel puts an app with no login on the
public internet.

---

## Running locally, without Kubernetes

**Straight bun** — the normal dev/laptop path:

```sh
bun install
ZNOTES_VAULT="$HOME/notes-vault" bun server/index.ts     # http://localhost:4700
```

`http://localhost` is a *trustworthy origin*, so WebCrypto works and secrets are
fully functional with no certificate anywhere. That stops being true the moment
you reach the same process at `http://<lan-ip>:4700` — then it is an insecure
context and SPEC §6 degradation kicks in. That gap is the entire reason for the
TLS machinery above.

**The image, without k8s** — useful for checking the container before deploying:

```sh
mkdir -p "$HOME/notes-vault" && sudo chown 1000:1000 "$HOME/notes-vault"
docker run --rm -p 4700:4700 -v "$HOME/notes-vault:/vault" z-notes:0.1.0
curl -fsS http://localhost:4700/healthz     # {"status":"ok"}
```

The bind-mounted directory must be writable by uid 1000 (the `bun` user); the
image never runs as root.

---

## Operating notes

**Health.** `GET /healthz` was added to `server/index.ts` for this: no disk, no
sqlite, no git — it answers only "is this process still serving HTTP". It also
serves as readiness, because `Bun.serve` is called *after* the boot-time full
reconcile, so the port does not open until the index is warm; and it flips to
503 the instant `shutdown()` starts, so the Service drops the endpoint before
the socket closes. All three probes point at it.

**Shutdown.** `terminationGracePeriodSeconds: 30` is headroom, not a drain
window. `shutdown()` closes the SSE streams, stops the reconciler, SIGKILLs
every live git child (so a push cannot outlive the pod), closes sqlite and
exits — milliseconds. The 30s only guarantees the kubelet never escalates to
SIGKILL, which would skip `index.close()`.

**If a pod is hard-killed mid-commit** git can leave `.git/index.lock` behind
and every later sync fails with "Unable to create index.lock". There is no
automatic reaper:

```sh
kubectl -n znotes exec deploy/znotes -- sh -c 'rm -f /vault/.git/index.lock'
```

**Backups.** The PVC is the only durable state, and one part of it is *not*
rebuildable: the sqlite index also stores the GitHub token, the AI key, chat
history and proposal pre-images (SPEC §5). Notes themselves are additionally
protected by git sync. local-path puts the volume under
`/var/lib/rancher/k3s/storage/<pvc-…>/` on the node.

**Rebuilding the index** (`rm /vault/.znotes/index.db*`, then restart) is safe
for notes and *destroys* those credentials and the AI history. Re-enter them in
settings afterwards.

**Never scale past one replica.** The reasons are in a long comment on
`replicas:` in `20-deployment.yaml`: one sqlite writer, one `fs.watch`
reconciler whose lock is a process-local JS mutex, one git working tree.
Multi-*device* is already supported and is a different thing — every browser on
the tailnet talks to this one process, and the doc-rev + SSE model (SPEC §5)
makes concurrent viewers safe.

**Traefik and SSE.** `/events` is a long-lived stream (`idleTimeout: 0` plus a
20s heartbeat). Traefik does not buffer, so it works untouched — but do not
attach a `compress` or `buffering` middleware to this router. Either one makes
live updates silently stop while every request still returns 200.

---

## What was verified, and what was not

Verified on this machine:

- **`/healthz` end to end** — added to `server/index.ts`, server started against a
  temp vault: `GET → 200 {"status":"ok"}`, `HEAD → 200`, `POST → 405`.
- **Full test suite still green** — `bun test`: **382 pass, 0 fail**, 19 files.
- **The Dockerfile's install step**, run natively with the real `package.json`
  and `bun.lock`: `bun install --frozen-lockfile --production --ignore-scripts`
  → 10 packages, `puppeteer-core` correctly excluded.
- **The base image**, by pulling its manifest and config from Docker Hub:
  `oven/bun:1.3.14-slim` exists for **linux/amd64 and linux/arm64**, is Debian
  *trixie*-slim (so `apt-get install git` is right), creates user `bun` with
  **uid/gid 1000** and home `/home/bun`, and presets
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` — which is what makes
  `readOnlyRootFilesystem: true` safe. Its entrypoint script was extracted and
  read: it ends in `exec "$@"`, so with `CMD ["bun","server/index.ts"]` **bun is PID 1
  and receives SIGTERM directly**.
- **How the frontend is served today** — read `serveStatic()`/`buildVendor()` in
  `server/index.ts` and confirmed prod serves `app/` verbatim with an in-memory vendor
  bundle. That is why the image ships no `dist/`.
- **`kubectl kustomize deploy/k3s`** renders cleanly; the image tag override
  lands, and `labels`/`includeSelectors:false` leaves `selector.matchLabels`
  untouched (`commonLabels` would have mutated an immutable field).
- **Every manifest parses** as YAML (PyYAML, all 9 files, 16 documents).
- **Every `apiVersion`/`kind` resolves against the real target cluster's
  discovery data** (found cached in `~/.kube/cache`, copied to scratch and used
  offline): all 11 kustomize objects plus the 4 across the two `alt-*` files map
  to live resources — `cert-manager.io/v1` (Certificate, Issuer) and
  `traefik.io/v1alpha1` (IngressRoute, Middleware) are both installed there, and
  Traefik is **v3**, so `traefik.io/v1alpha1` is the correct group. The
  `tailscale.com/v1alpha1` operator CRDs are present too, which is why option B
  is offered.

**Not** verified, and why:

- **`docker build` was never run.** The `docker` CLI exists but no daemon is
  reachable (`/var/run/docker.sock` absent). The Dockerfile is therefore
  validated indirectly: the install command run natively, the base image's user,
  distro, arch, env and entrypoint read from the registry, and the `COPY` file
  list checked against the repo. **Un-run steps remain `apt-get install git
  ca-certificates` and the layer assembly.**
- **No server-side schema validation.** `kubectl` is present (v1.36.1) and a
  cluster *is* configured, but it is unreachable right now (`no route to host`),
  and `kubectl --validate` needs the API server's OpenAPI document —
  `--dry-run=client` cannot substitute. `kubeconform`/`kubeval` are not
  installed. So **kinds and API groups are confirmed; individual field names and
  types are not.**
- **Nothing was applied to a cluster**, so cert issuance, Traefik routing, the
  probes under a real kubelet, and fsGroup ownership on a local-path volume are
  all unexercised.
- **Resource limits are estimates**, not measurements. `768Mi` is a meaningful
  slice of a small Raspberry Pi — check `kubectl describe node` before applying
  if that is your node.
