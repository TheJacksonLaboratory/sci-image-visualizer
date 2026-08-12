# Deploy the tile server as a pod on the dev cluster

Runs the tile server **in** the dev GKE cluster (see `$CLUSTER` / `$CLUSTER_PROJECT` below)
behind the cluster's existing nginx ingress, exposed publicly (no auth) via a
**split Ingress** at `https://imagetools-dev.jax.org/tiles-api/`. This reuses the
LB + TLS and makes the gigapixel demo reachable from the public GitHub Pages site
without the Cloud Run `allUsers` block.

The demo is wired to it via `VITE_TILE_SERVER=https://imagetools-dev.jax.org/tiles-api/`
in `.github/workflows/pages.yaml`.

## What's deployed

- **Namespace:** `jit-tile-example` · **Deployment/Service:** `tile-server` · **Ingress:** `tile-server-public`
- **Image:** `us-east1-docker.pkg.dev/$IMAGE_PROJECT/jit-tile-example/tile-server:v1`
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
| `$CLUSTER` / `$CLUSTER_PROJECT` | the dev GKE cluster and its project |
| `$CLUSTER_PROJECT_NUMBER` | that project's numeric id (for the Workload Identity pool) |
| `$CLUSTER_NODE_SA` | the cluster's node service account |
| `$IMAGE_PROJECT` | the project hosting the Artifact Registry repo |
| `$AR_READER_SA` | a service account with Artifact Registry read |

## One-time setup

```bash
# 1. Build + push the image (project $IMAGE_PROJECT, us-east1 AR)
gcloud artifacts repositories create jit-tile-example \
  --repository-format=docker --location=us-east1 --project=$IMAGE_PROJECT
gcloud builds submit examples/tile-server \
  --tag us-east1-docker.pkg.dev/$IMAGE_PROJECT/jit-tile-example/tile-server:v1 \
  --project=$IMAGE_PROJECT

# 2. Let the pod read the COG bucket (Workload Identity principal — no GSA)
gcloud storage buckets add-iam-policy-binding gs://jax-cimg-tile-cogs-use1 \
  --role=roles/storage.objectViewer \
  --member="principal://iam.googleapis.com/projects/$CLUSTER_PROJECT_NUMBER/locations/global/workloadIdentityPools/$CLUSTER_PROJECT.svc.id.goog/subject/ns/jit-tile-example/sa/tile-server"

# 3. DURABLE IMAGE PULL — a docker-registry pull secret from an image-project
#    SA key that has AR read (the deployment SA references it via imagePullSecrets).
kubectl -n jit-tile-example create secret docker-registry ar-pull \\
  --docker-server=us-east1-docker.pkg.dev --docker-username=_json_key \\
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
