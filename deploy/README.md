# Deploying z-notes

```
browser (laptop / phone, on the tailnet)
   │  https://znotes.tailb95e62.ts.net  (canonical)   or   https://znotes.k3s.lan  (LAN break-glass)
   ▼                                                        ▼
Tailscale operator proxy ── Let's Encrypt cert     Traefik (bundled with k3s) ── cert-manager's private CA
   └──────────────────────────────┬─────────────────────────┘
                                  ▼
Service znotes (ClusterIP :80)
   ▼
Deployment znotes — ONE replica, bun server/index.ts, :4700, serving dist/ (ZNOTES_DIST)
   └── PVC znotes-vault mounted at /vaults        ← the vaults home: one dir per vault
        ├── vault/                                the PRIMARY — app state lives here
        │    ├── *.md                             the notes (source of truth)
        │    ├── .git/                            its own repo + remote — or none: an
        │    │                                    unsynced vault is a working vault
        │    └── .znotes/
        │         ├── settings.toml, vault.pub, identity.age   (committed)
        │         └── index.db{,-wal,-shm}                     (sqlite WAL, untracked)
        └── work-notes/                           a secondary — same layout, own remote
             ├── *.md
             ├── .git/
             └── .znotes/…
```

**One PVC, N vaults.** Every directory under `/vaults` is a whole vault: its own
git repository, its own sqlite index, its own trash and sync cadence (ADR 0018).
The primary is not a different kind of thing — it is simply the one named
`vault`, and it is where the app's own state lives (settings, keyring, AI relay,
terminal). The claim is still called `znotes-vault` because renaming it would
bind a new, empty volume; the name is history, the mount is the truth.

**No app-level auth, by design**: the cluster and the
tailnet are the perimeter. The only credential in the product is the vault
passphrase, and that guards the age identity, not the app. Consequence: do not
expose the Ingress to the public internet, and do not give the Service a
NodePort or LoadBalancer.

**TLS is not decoration.** The app encrypts secrets in the browser with
WebCrypto, which only exists in a secure context. Over plain HTTP the app still
runs — degradation is required, not optional — but every secret block stays
armored and unlock is replaced by an explanatory badge.

## Files

| | |
|---|---|
| `Dockerfile` | production image. Build context is the **repo root**. |
| `../.dockerignore` | at the repo root because that is where the builder looks. |
| `k3s/00…60-*.yaml` | the deployment; apply with `kubectl apply -k deploy/k3s`. |
| `k3s/60-tailscale-ingress.yaml` | the canonical address: Tailscale operator ingress — real cert, no trust step (ADR 0042). |
| `k3s/alt-ingressroute.yaml` | Traefik CRD form of the Ingress. Either/or. |
| `../scripts/check-single-volume.sh` | proves the image's volume contract against a real container: one mount at `/vaults`, a primary that creates itself, a second vault as a sibling directory, all of it surviving a container replacement. Needs a docker daemon. |

`alt-ingressroute.yaml` is excluded from `kustomization.yaml` on purpose; apply it
by hand if you want it.

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

The image build **builds the frontend** (ADR 0040). In the `src` stage,
`bun scripts/build.ts` runs one `Bun.build` over the boot entry, the BlockNote
island and the crypto worker into a content-hashed `/src/dist`: hashed files
under `/assets/`, brotli and gzip beside every textual one, the service worker,
and a `build.json` manifest. The runtime stage copies `server/`, `dist/` and
`package.json` — **no `node_modules`, no `app/`** — and sets
`ZNOTES_DIST=/app/dist`, so the server loads the build at boot, bundles nothing
and compresses only the small finished shell. A frontend that does not build fails the image build, not the
deploy. The same stage then deletes `node_modules` and runs the module-graph
check, which proves the server imports nothing from npm. The base image is
`oven/bun:1.4.4-slim` throughout; bundler output can differ from the 1.4.0 a
developer may have locally, and the image is the release build.

Without `ZNOTES_DIST` (dev, tests) the server runs the same build in memory.
`bun run build` writes `dist/` locally if you want to run the image's path
without Docker: `bun run build && ZNOTES_DIST=./dist bun server/index.ts`.
`--compile` is avoided: it reports `import.meta.dir` as `/$bunfs/root`, which
`server/index.ts` uses to locate `app/`. (The vaults and their DBs are already
immune — they come from `$ZNOTES_VAULTS_DIR`, i.e. the mount.)

## 2. Push it to the registry

The cluster pulls from `ghcr.io/zees-dev/z-notes` (ADR 0005). Containerd stores
layers by digest, so a release whose only change is app code ships ~2MB — the
Bun base layers are already on the node:

```sh
gh auth token | docker login ghcr.io -u zees-dev --password-stdin
docker tag z-notes:0.1.X ghcr.io/zees-dev/z-notes:0.1.X
docker push ghcr.io/zees-dev/z-notes:0.1.X
cd deploy/k3s && kustomize edit set image z-notes=ghcr.io/zees-dev/z-notes:0.1.X
```

The package is private (the repo is), so the `znotes` namespace carries an
`imagePullSecret` named `ghcr-creds` — created out-of-band, never committed:

```sh
kubectl -n znotes create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io --docker-username=zees-dev --docker-password=<PAT>
```

The PAT needs `read:packages` (classic — GHCR does not reliably accept
fine-grained tokens for registry auth).

`imagePullPolicy` is `IfNotPresent` — tags are pinned and never reused, so a
node that already has the tag has the release.

The pre-registry side-load path still works when ghcr (or the WAN) is down:
`docker save z-notes:0.1.X | gzip`, `scp` to the node, `sudo k3s ctr images
import` — then retag the import to the ghcr name so the pinned manifest matches.

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

Two files carry `znotes.k3s.lan`, and both must agree with what you type in
the browser or you get a name-mismatch error that looks exactly like an
untrusted-CA error:

- `k3s/40-certificates.yaml` — `commonName` + `dnsNames`
- `k3s/50-ingress.yaml` — `tls[].hosts` and both `rules[].host`

`k3s.lan` is the cluster's zone: the LAN resolver serves a `*.k3s.lan` wildcard
pointing at the Traefik nodes, so every app is `<name>.k3s.lan` and no device
needs a hosts entry. On a LAN without such a wildcard, point the name at the
node yourself:

```sh
echo "<node-ip>  znotes.k3s.lan" | sudo tee -a /etc/hosts   # or a LAN DNS record
```

This LAN name is the **break-glass** (section 7). The canonical address is the
MagicDNS one, `https://znotes.tailb95e62.ts.net`, served by the Tailscale
operator with its own certificate — it does not use this hostname, this
certificate or these two files. If you move to another tailnet, change the name
in `k3s/60-tailscale-ingress.yaml`, `ZNOTES_ORIGIN` in `20-deployment.yaml` and
the redirect in `50-ingress.yaml` together.

## 5. Apply

```sh
kubectl apply -k deploy/k3s
kubectl -n znotes rollout status deploy/znotes
kubectl -n znotes get certificate         # both should read READY=True
```

`znotes-ca` must go Ready before `znotes-tls` can — the second is signed by the
first. If `znotes-tls` is stuck, `kubectl -n znotes describe certificate
znotes-tls` names the reason.

### Seeding a fresh PVC from your vault repo (optional)

The PVC starts empty and the image carries no notes (ADR 0005/0017), so first
boot creates `/vaults/vault` and serves it as an empty offline vault until you
give it one. Two env vars on the Deployment turn that first boot into the
seeding step — no `kubectl exec`, no hand-run `git init`, which is how this PVC
used to be filled:

```yaml
- name: ZNOTES_VAULT_REPO
  value: https://github.com/you/vault.git
- name: ZNOTES_GIT_TOKEN            # only for a private repo
  valueFrom:
    secretKeyRef: { name: znotes-git, key: token }
```

Both act on the **primary only** — `/vaults/vault`, and nothing else under the
mount. A secondary vault is added through the UI (`POST /api/vaults`), which is
the same attach operation with a directory created for it; there is no env var
that seeds one, and none is wanted, because the filesystem is already the
registry.

On boot the pod **attaches** the primary to that remote — init, `origin`, fetch,
checkout — and then syncs on its own from there. It is deliberately soft: a
vault that is already its own repo is left alone (so restarts are idempotent,
and the env vars are a bootstrap, not an enforcer), and an unreachable remote or
a rejected token logs the failure and boots anyway, into a working offline vault
whose sync status carries the error. It never overwrites a file, so pointing it
at a repo whose files clash with what is already on the PVC is a refusal naming
the paths, not a loss.

**`ZNOTES_GIT_TOKEN` is first-run only.** It is absorbed into the sqlite
credential store on the boot that finds none stored and is ignored ever after —
rotation happens in the settings UI, where it cannot be clobbered by a stale
manifest. Once the first boot has happened you can drop the env var (and the
Secret) entirely; the token lives in the primary's `.znotes/index.db` from then
on. That is the only reason a credential appears in this manifest at all — the
note on secrets in `20-deployment.yaml` otherwise still holds.

### The mount is the vaults home

This is not an add-on; it is the layout. `ZNOTES_VAULTS_DIR` is the **vaults
home** — one subdirectory per vault, every one of them a full vault with its own
git remote, branch, cadence, trash and index (ADR 0018) — and the Deployment
sets it to the one mount:

```yaml
- name: ZNOTES_VAULTS_DIR
  value: /vaults
```

There is deliberately **no `ZNOTES_VAULT`** in the image or the manifest. The
primary defaults to `$ZNOTES_VAULTS_DIR/vault`, so it is just the directory
named `vault` sitting beside the others: special in what it *owns* — the app's
settings, the keyring, the AI relay, the terminal, and the seeding above — never
in where it sits. Setting `ZNOTES_VAULT` is still possible and is now a
deviation: it would park the primary somewhere the one PVC does not cover, which
is exactly the two-mounts-meaning-different-things shape this replaced. (The
boot scan skips whichever subdirectory is the primary, by real path, so nothing
is ever indexed twice either way.)

**The filesystem is the registry.** `/vaults` is scanned at boot, so a vault
added through the UI is simply a directory that is there on the next start —
nothing to migrate, no list to keep in step, and `rm -rf` is a supported way to
be rid of one. Two overlaps are refused, because both would index the same files
twice: the home INSIDE the primary vault, and the primary sitting deeper than a
direct child of the home. Either one costs the secondary vaults, never the app.

Give the home durable storage or lose every vault on reschedule — which the one
PVC above already does, for all of them at once. That is the whole reason there
is exactly one claim: a vault added in the UI at 9am is on the same durable
volume as the primary, with no manifest edit and no second claim to remember.

The single-replica invariant below is **unchanged**: more vaults still means one
sqlite writer, one reconciler and one git working tree *per vault*, all inside
one process. Two operational notes simply repeat per vault: the `.git/index.lock`
recipe below applies at `/vaults/<id>/.git/`, and the backup argument applies to
every vault directory, since each holds its own `.znotes/index.db` with that
vault's git token.

### Migrating a PVC that predates the vaults home

**The change in one sentence: the PVC's root stops being a vault and becomes a
directory *of* vaults — everything at the root today moves down one level into
`vault/`, which is then the primary.** The mount moves from `/vault` to
`/vaults`; the claim keeps its name.

Nothing in the app does this for you, on purpose. The registry is the
filesystem, so moving the files *is* the migration: there is no schema version,
no marker file and no half-applied state to reason about. It is one `mv`, done
once, with the pod stopped. Skip it entirely on a fresh install — an empty PVC
just grows `/vaults/vault` on first boot.

**1 — Make it recoverable.** Sync the vault — the statusbar control, or
`curl -X POST https://znotes.k3s.lan/api/sync/now` — until sync status reads
`synced` with `ahead: 0`. Every note is then on the remote, and the notes half
of this is recoverable from a `git clone` even if the volume evaporates. Then be
clear-eyed about the other half: `.znotes/` is
**not** all in git. `index.db` holds the GitHub token, the AI key, the terminal
password hash, the AI chat history and the proposal pre-images, and none of that
is anywhere else. Losing it is not losing notes, but it is losing credentials.

**2 — Stop the writer.** Nothing may be writing while the tree moves under it,
and this also closes sqlite cleanly so the backup in step 3 is a consistent one:

```sh
kubectl -n znotes scale deploy/znotes --replicas=0
kubectl -n znotes get pod -w        # wait until no znotes pod is left
```

**3 — Back up `.znotes/`.** local-path puts the volume under
`/var/lib/rancher/k3s/storage/`, in a directory named for the PV, the namespace
and the claim. On the node, with the process gone and the WAL quiesced:

```sh
sudo -i
d=$(ls -d /var/lib/rancher/k3s/storage/pvc-*_znotes_znotes-vault)   # exactly one
cp -a "$d/.znotes" /root/znotes-meta-backup-$(date +%F)
```

Copy that off the node if you care about it — a backup on the disk you are about
to edit is a backup of the wrong thing.

**4 — The move.** Same shell, same `$d`:

```sh
if [ -e "$d/vault" ]; then
  echo "already migrated: $d/vault exists — stop here"; exit 1
fi
mkdir "$d/vault"
find "$d" -mindepth 1 -maxdepth 1 ! -name vault -exec mv -t "$d/vault" -- {} +
chown 1000:1000 "$d/vault"
ls -a "$d/vault"        # expect .git  .znotes  *.md  your folders
```

The `find` is what moves the **dotfiles** — `.git` and `.znotes` are the whole
point, and a bare `mv "$d"/* ` silently leaves them behind, which boots you into
an empty vault sitting next to your real one. The `-e "$d/vault"` guard is what
makes this safe to run twice: a second run refuses instead of nesting
`vault/vault`. And note what this is *not*: `mv` within one filesystem is
`rename(2)`, so a 400MB `.git` moves instantly, ownership and timestamps
untouched. Only the new `vault/` directory is created by root, which is why it
gets the explicit `chown` to uid 1000 — the `bun` user the container runs as.

**Not on local-path?** Do the same move in a one-shot pod that mounts the claim,
which works on any storage class (the Deployment must still be at 0 replicas —
the claim is RWO):

```sh
kubectl -n znotes run vault-migrate --rm -it --restart=Never \
  --image=busybox:1.36 --overrides='{"spec":{"securityContext":{"runAsUser":0},
  "containers":[{"name":"m","image":"busybox:1.36","stdin":true,"tty":true,
  "command":["sh"],"volumeMounts":[{"name":"v","mountPath":"/mnt"}]}],
  "volumes":[{"name":"v","persistentVolumeClaim":{"claimName":"znotes-vault"}}]}}'
# then, inside it:
cd /mnt
if [ -e vault ]; then echo "already migrated"; exit 1; fi
mkdir vault
for e in * .*; do case "$e" in .|..|vault) continue;; esac; [ -e "$e" ] && mv -- "$e" vault/; done
chown 1000:1000 vault
ls -a vault
```

**5 — Ship a new image, then apply.** The Deployment now mounts the same claim
at `/vaults` and sets `ZNOTES_VAULTS_DIR`; `kubectl apply` replaces the old
mount path in place, and the `replicas` in the manifest undoes step 2:

```sh
# steps 1–2 above: build, push, `kustomize edit set image` — then
kubectl apply -k deploy/k3s
kubectl -n znotes rollout status deploy/znotes
```

**Do not skip the image.** A pre-vaults-home image bakes `ENV
ZNOTES_VAULT=/vault`, and the new manifest deliberately sets no `ZNOTES_VAULT`
to override it — so that stale image would put the primary back at `/vault`,
which nothing mounts any more, and serve it: empty, ephemeral, gone at the next
restart. Your real notes would be sitting at `/vaults/vault` and the boot scan
would step straight over them, because `vault` is the primary's reserved id and
never a secondary's (the log says `skipping vault — not a vault id`). Nothing is
lost and nothing is visible, which is the worst way to find out. New manifests
want the new image; move them together.

**6 — Verify, before you trust it.** Ask the app where its vaults are:

```sh
curl -s https://znotes.k3s.lan/api/vaults | jq '.vaults[] | {id, root, remote, docCount}'
# or, without DNS/TLS in the way:
# kubectl -n znotes port-forward deploy/znotes 4700:4700 & curl -s localhost:4700/api/vaults | jq
```

The primary must come back as `"id": "vault"`, `"root": "/vaults/vault"`, the
**same remote** it had before, and a `docCount` matching what you had — a zero
there means the move left the notes somewhere the scan is not looking. Then open
the app: sync goes green without re-entering the token (that is `.znotes/index.db`
having survived the move), and the notes are the notes.

If any of that is wrong, the way back is the way in: scale to 0, move the
contents of `vault/` back up one level, and re-apply the previous manifests.

## 6. Trust the CA (break-glass only)

Skip this unless you want `https://znotes.k3s.lan` to be warning-free. The
canonical address (section 7) needs nothing installed. Even trusted, the LAN
name is not the offline origin: the service worker and replica run only on
`ZNOTES_ORIGIN`.

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

Then open `https://znotes.k3s.lan`. Confirm the secure context actually took:
the secrets UI should offer unlock rather than the degraded badge, and
`window.isSecureContext` in the console should be `true`.

The 90-day server certificate rotates on its own; you never repeat this step.

## 7. The canonical address, and the break-glass

**Canonical: `https://znotes.tailb95e62.ts.net`** (ADR 0042). The Tailscale
Kubernetes operator (`k3s/60-tailscale-ingress.yaml`) joins a proxy to your
tailnet as a device and Tailscale issues a **real, publicly-trusted** certificate
for it, so no device installs anything and step 6 never applies. This is the one
origin where the app installs, registers its service worker and keeps the offline
replica (`ZNOTES_ORIGIN` in `20-deployment.yaml`; ADR 0041). Open it, then
install it from Chrome on each device.

Prerequisites, per device:

- **The Tailscale app is connected.** The name resolves only on the tailnet, and
  on Android Tailscale takes the one VPN slot. An installed app still opens
  offline from its cache with Tailscale off; it just cannot reach the server.
- **Android: Private DNS must not be a strict hostname.** Settings › Network ›
  Private DNS set to a provider hostname bypasses MagicDNS, so the name never
  resolves. Use Off or Automatic.

Prerequisites, once: the operator installed, MagicDNS and HTTPS certificates
enabled in the tailnet admin console (both are off by default), and an OAuth
client you create there (nothing here ships a credential). The operator is
reachable only from the tailnet.

**Break-glass: `https://znotes.k3s.lan`** (sections 3–6: cert-manager, Traefik,
the private CA). It works without Tailscale, on the LAN, and the app works there
online — but it runs no service worker and no replica, and shows a notice naming
the canonical address. Use it when Tailscale is down. Plain `http://znotes.k3s.lan`
redirects to `https://znotes.k3s.lan` (`redirect-https` in `50-ingress.yaml`),
so the old name keeps working on a device without Tailscale.

The perimeter argument holds unchanged: the tailnet is the auth boundary. Keep
ACLs tight and do not enable Funnel — Funnel puts an app with no login on the
public internet.

**Kill switch for the service worker.** If a release ships a service worker that
misbehaves, set `ZNOTES_SW=off` on the Deployment (the commented env entry in
`20-deployment.yaml`) and redeploy. `/sw.js` then serves a worker that, on its
next update check, deletes the `znotes-*` caches, unregisters itself and
reloads the open windows. It never touches IndexedDB, so unsent offline edits
survive. Remove the variable and redeploy to turn the worker back on.

---

## Running locally, without Kubernetes

**Straight bun** — the normal dev/laptop path:

```sh
bun install
bun server/index.ts                                      # http://localhost:4700
ZNOTES_VAULTS_DIR="$HOME/notes" bun server/index.ts      # …or keep them elsewhere
```

Every vault lives under `ZNOTES_VAULTS_DIR` — `./vaults` in the repo, gitignored —
one subdirectory each, the primary at `vaults/vault` and created on first boot.
Point `ZNOTES_VAULT` somewhere else only if the primary belongs outside that home.

`http://localhost` is a *trustworthy origin*, so WebCrypto works and secrets are
fully functional with no certificate anywhere. That stops being true the moment
you reach the same process at `http://<lan-ip>:4700` — then it is an insecure
context, so secrets degrade to armored-only. That gap is the entire reason for
the TLS machinery above.

**The image, without k8s** — useful for checking the container before deploying:

```sh
mkdir -p "$HOME/vaults" && sudo chown 1000:1000 "$HOME/vaults"
docker run --rm -p 4700:4700 -v "$HOME/vaults:/vaults" z-notes:0.1.0
curl -fsS http://localhost:4700/healthz     # {"status":"ok"}
```

You mount the **vaults home**, not a vault: `/vaults` is what the image sets
`ZNOTES_VAULTS_DIR` to, and a fresh directory grows `$HOME/vaults/vault` — the
primary — on first boot. Drop other vaults in beside it and they are picked up
at the next start. The bind-mounted home must be writable by uid 1000 (the `bun`
user), since everything under it is created by the container; the image never
runs as root.

If you used to run `-v "$HOME/notes:/vault"`, that path means nothing now and
the container would boot into a fresh, empty primary. Same fix as the cluster
migration, one level down: `mkdir -p "$HOME/vaults" && mv "$HOME/notes"
"$HOME/vaults/vault"`, then mount the home.

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
kubectl -n znotes exec deploy/znotes -- sh -c 'rm -f /vaults/vault/.git/index.lock'
```

It is per-vault, because the repository is: the same lock can strand
`/vaults/<id>/.git/` for any other vault, and clearing one says nothing about
the others. `rm -f /vaults/*/.git/index.lock` does the lot when you would rather
not work out which.

**Backups.** The one PVC is the only durable state, and one part of it is *not*
rebuildable: each vault's sqlite index also stores that vault's GitHub token,
plus — in the primary's — the AI key, chat history and proposal pre-images.
Notes themselves are additionally protected by git sync, per vault, so what a
backup is really for is `/vaults/*/.znotes/index.db`. local-path puts the volume
under `/var/lib/rancher/k3s/storage/<pvc-…>/` on the node; that directory is now
the vaults home, so one copy of it takes every vault at once.

**Rebuilding an index** (`rm /vaults/<id>/.znotes/index.db*`, then restart) is
safe for notes and *destroys* that vault's credentials, and the AI history if it
was the primary's. Re-enter them in settings afterwards.

**Never scale past one replica.** The reasons are in a long comment on
`replicas:` in `20-deployment.yaml`: one sqlite writer, one `fs.watch`
reconciler whose lock is a process-local JS mutex, one git working tree.
Multi-*device* is already supported and is a different thing — every browser on
the tailnet talks to this one process, and the doc-rev + SSE model
makes concurrent viewers safe.

**Traefik and SSE.** `/events` is a long-lived stream (`idleTimeout: 0` plus a
20s heartbeat). Traefik does not buffer, so it works untouched — but do not
attach a `compress` or `buffering` middleware to this router. Either one makes
live updates silently stop while every request still returns 200.

**Assets: precompressed at build, cached by the browser (ADR 0038, 0040).** The
image build brotli (q11) and gzip-codes every textual asset; the process loads
`dist/` and serves the right bytes per `accept-encoding`, so no ingress
middleware needs to compress, and one must not be added for SSE's sake anyway
(above). JSON API responses of 1 KiB or more are coded by the process too
(brotli q4, else gzip), never `/events` or the streaming routes. Boot loads files
and compresses nothing; the port opens after the load, so readiness still means
ready.

Caching is two policies, and which one a path gets follows from its URL.
Content-addressed assets — everything under `/assets/` — carry
`public, max-age=2592000, immutable`: **one month**, safely, because the hash IS
the URL and a new image serves new URLs. Everything else — the shell (`/`,
`/d/*`, `/settings/*`), `/sw.js`, `themes/*.css`, `manifest.json`, the icons —
carries `no-cache` and an `ETag` (a content hash, so a second pod would agree),
and that is deliberate: those paths keep their names across releases, so a
month of freshness would mean a rollout that an already-warm browser does not
see until it expires. They revalidate instead, and a revalidation is a few
hundred bytes of `304`. **So a deploy needs no cache bust**, and nothing needs
purging at the ingress. A browser without the service worker picks up the new
shell on its next load. An installed app keeps its own release until the user
accepts the "A new version is ready" prompt; the old release's assets are
cached on the device, so an open page never loses its lazy chunks.

---

## What was verified, and what was not

Most of what follows records the original bring-up. The move to the vaults home
came later and re-touched the `Dockerfile` and `20-deployment.yaml`, so any
claim measured against the *pre*-vaults-home manifests is marked as such below
rather than quietly re-asserted. `scripts/check-single-volume.sh` is the way to
settle the new ones on a machine with a docker daemon — it drives a real
container against a real volume — and nothing in this section records a run of
it.

Verified on this machine:

- **git's `safe.directory` glob**, in a container against a repository owned by
  root and read as uid 1000: git 2.47 accepts both `*` and the narrow
  `/vaults/*`, and the narrow form clears "detected dubious ownership" for a
  repo at `/vaults/<id>`. That is why `GIT_CONFIG_VALUE_0` is a glob now — one
  pinned path stopped being enough the moment there was more than one vault.
- **`/healthz` end to end** — added to `server/index.ts`, server started against a
  temp vault: `GET → 200 {"status":"ok"}`, `HEAD → 200`, `POST → 405`.
- **Full test suite still green** — `bun test`: **382 pass, 0 fail**, 19 files.
- **The Dockerfile's install step**, run natively with the real `package.json`
  and `bun.lock`: `bun install --frozen-lockfile --production --ignore-scripts`
  → 10 packages, `puppeteer-core` correctly excluded.
- **The base image**, by pulling its manifest and config from Docker Hub:
  `oven/bun:1.4.0-slim` (re-verified at the 1.4 pin; the 1.3.14 record read the
  same) exists for **linux/amd64 and linux/arm64**, is Debian
  *trixie*-slim (so `apt-get install git` is right), creates user `bun` with
  **uid/gid 1000** and home `/home/bun`, and presets
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` — which is what makes
  `readOnlyRootFilesystem: true` safe. Its entrypoint script was extracted and
  read: it ends in `exec "$@"`, so with `CMD ["bun","server/index.ts"]` **bun is PID 1
  and receives SIGTERM directly**.
- **`kubectl kustomize deploy/k3s`** renders cleanly; the image tag override
  lands, and `labels`/`includeSelectors:false` leaves `selector.matchLabels`
  untouched (`commonLabels` would have mutated an immutable field).
  *(Measured on the pre-vaults-home manifests; the mount-path edit has not been
  re-rendered here.)*
- **Every manifest parses** as YAML (PyYAML, all 9 files, 16 documents).
  *(Same vintage — same caveat.)*
- **Every `apiVersion`/`kind` resolves against the real target cluster's
  discovery data** (found cached in `~/.kube/cache`, copied to scratch and used
  offline): all 11 kustomize objects plus the 4 across the two `alt-*` files map
  to live resources — `cert-manager.io/v1` (Certificate, Issuer) and
  `traefik.io/v1alpha1` (IngressRoute, Middleware) are both installed there, and
  Traefik is **v3**, so `traefik.io/v1alpha1` is the correct group. The
  `tailscale.com/v1alpha1` operator CRDs are present too, which is why option B
  is offered.

**Not** verified, and why:

- **The built-frontend image (spec 0024) is verified only up to the browser.**
  Release 0.22.0 was built with podman (arm64) on 2026-10-28: the `src` stage's
  Bun 1.4.4 build and the module-graph check without `node_modules` passed, and
  the image is 329 MB (0.21.0 was 570 MB) with only `server/`, `dist/` and
  `package.json`. After `kubectl apply -k`, the Tailscale ingress served the
  canonical address with a Let's Encrypt certificate (the first request took
  37 s while it was issued), the shell headers, brotli and SSE passed through
  the proxy, and a headless Chromium on the tailnet registered the service
  worker, filled the replica with every doc and reopened offline. WebAPK
  minting on the phone and Safari are unexercised.

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
- **The migration runbook has not been run.** It is written from the manifests
  and from how local-path lays a volume out, not from a rehearsal on a copy of
  the real PVC. The guards are there because of that, not in spite of it: it
  refuses when `vault/` already exists, and it asks for the `.znotes/` backup
  first. Take the backup.
- **Resource limits are estimates**, not measurements. `768Mi` is a meaningful
  slice of a small Raspberry Pi — check `kubectl describe node` before applying
  if that is your node.
