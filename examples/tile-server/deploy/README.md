# Deploy the tile server as a pod on the dev cluster

Runs the tile server **in** the dev GKE cluster
behind the cluster's existing nginx ingress, exposed publicly (no auth) via a
**split Ingress** at `https://imagetools-dev.jax.org/tiles-api/`. This reuses the
LB + TLS and makes the gigapixel demo reachable from the public GitHub Pages site
without the Cloud Run `allUsers` block.

The demo is wired to it via `VITE_TILE_SERVER=https://imagetools-dev.jax.org/tiles-api/`
in `.github/workflows/pages.yaml`.

## What's deployed

- **Namespace:** `jit-tile-example` · **Deployment/Service:** `tile-server` · **Ingress:** `tile-server-public`
- **Image:** `us-docker.pkg.dev/jax-cs-registry/docker/jit-tile-server:v1`
  (multi-region `us-docker.pkg.dev`, not `us-east1-`)
- **COGs:** `gs://jax-cimg-tile-cogs-use1` (us-east1, project `jax-cloud-image-tools`),
  mounted read-only via the GCS Fuse CSI driver at `/mnt/cogs` with `implicit-dirs`
  (the `cmu-1/ bc18/ sirius-red/` prefixes have no placeholder objects).
- **Auth to GCS:** Workload Identity — the `tile-server` KSA principal is granted
  `roles/storage.objectViewer` on the bucket (cross-project).
- **Cost:** ~$0 incremental (fits spare node capacity) + egress; see the chat analysis.

## Prerequisites (already true on dev)

- GCS Fuse CSI driver: enabled ✓ · Workload Identity: enabled ✓ · cert-manager: ✓

## Placeholders

The commands below use placeholders rather than hardcoded identifiers, since this
is a public repository. Fill them from your own environment:

| | |
|---|---|
| `$CLUSTER_PROJECT` | the project holding the dev GKE cluster |
| `$CLUSTER_PROJECT_NUMBER` | that project's numeric id (for the Workload Identity pool) |
| `$CLUSTER_NODE_SA` | the cluster's node service account |
| `$IMAGE_PROJECT` | the project hosting the Artifact Registry repo. The committed
  manifests use `jax-cs-registry`, chosen because the cluster can pull from it
  without a secret |
| `$AR_READER_SA` | a service account with Artifact Registry read. Only needed for
  the optional pull-secret route below |
| `$OTHER_REGISTRY_HOST` | registry host for that optional route, e.g.
  `us-east1-docker.pkg.dev` |

## One-time setup

```bash
# 1. Build + push the image, to a registry the cluster can already read.
#    Cloud Build is not enabled on jax-cs-registry, so build locally and push, or
#    build with Cloud Build elsewhere and copy the image across.
gcloud auth print-access-token \
  | docker login -u oauth2accesstoken --password-stdin https://us-docker.pkg.dev
docker build -t us-docker.pkg.dev/jax-cs-registry/docker/jit-tile-server:v1 examples/tile-server
docker push us-docker.pkg.dev/jax-cs-registry/docker/jit-tile-server:v1
#    Use a NEW tag for a rebuild: overwriting one leaves running pods on the old
#    image with no way to tell.

# 2. Let the pod read the COG bucket (Workload Identity principal — no GSA)
gcloud storage buckets add-iam-policy-binding gs://jax-cimg-tile-cogs-use1 \
  --role=roles/storage.objectViewer \
  --member="principal://iam.googleapis.com/projects/$CLUSTER_PROJECT_NUMBER/locations/global/workloadIdentityPools/$CLUSTER_PROJECT.svc.id.goog/subject/ns/jit-tile-example/sa/tile-server"

# 3. OPTIONAL — only if you point the image at a registry the cluster cannot
#    read. Creates a pull secret from a long-lived SA key, and you must also add
#    `imagePullSecrets: [{name: ar-pull}]` back to serviceaccount.yaml. Prefer
#    step 1's registry and skip this entirely.
kubectl -n jit-tile-example create secret docker-registry ar-pull \\
  --docker-server=$OTHER_REGISTRY_HOST --docker-username=_json_key \\
  --docker-password="$(cat <sa-key>.json)" \\
  --docker-email=$AR_READER_SA
```

> **Alternative (no secret, cleaner)** — grant the cluster's node SA cross-project
> AR read; needs an Artifact Registry admin on the image project:
> `gcloud artifacts repositories add-iam-policy-binding jit-tile-example --location=us-east1 --project=$IMAGE_PROJECT --member="serviceAccount:$CLUSTER_NODE_SA" --role=roles/artifactregistry.reader`

## Deploy

```bash
kubectl apply -k examples/tile-server/deploy/k8s
kubectl -n jit-tile-example rollout status deploy/tile-server
curl https://imagetools-dev.jax.org/tiles-api/images   # public, no auth
```

## Data-governance switch

The public route serves **whatever the pod mounts**. To expose only CC0 `cmu-1`
and keep `bc18`/`sirius-red` private, mount a bucket that holds only `cmu-1/`.

## Teardown

```bash
kubectl delete -k examples/tile-server/deploy/k8s
```
