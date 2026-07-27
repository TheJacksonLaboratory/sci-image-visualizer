# Deploy the tile server as a pod on the dev cluster

Runs the tile server **in** `jax-cluster-dev-10` (project `jax-compsci-nc-dev-01`)
behind the cluster's existing nginx ingress, exposed publicly (no auth) via a
**split Ingress** at `https://imagetools-dev.jax.org/tiles-api/`. This reuses the
LB + TLS and makes the gigapixel demo reachable from the public GitHub Pages site
without the Cloud Run `allUsers` block.

The demo is wired to it via `VITE_TILE_SERVER=https://imagetools-dev.jax.org/tiles-api/`
in `.github/workflows/pages.yaml`.

## What's deployed

- **Namespace:** `jit-tile-example` · **Deployment/Service:** `tile-server` · **Ingress:** `tile-server-public`
- **Image:** `us-east1-docker.pkg.dev/jax-cloud-image-tools/jit-tile-example/tile-server:v1`
- **COGs:** `gs://jax-cimg-tile-cogs-use1` (us-east1, project `jax-cloud-image-tools`),
  mounted read-only via the GCS Fuse CSI driver at `/mnt/cogs` with `implicit-dirs`
  (the `cmu-1/ bc18/ sirius-red/` prefixes have no placeholder objects).
- **Auth to GCS:** Workload Identity — the `tile-server` KSA principal is granted
  `roles/storage.objectViewer` on the bucket (cross-project).
- **Cost:** ~$0 incremental (fits spare node capacity) + egress; see the chat analysis.

## Prerequisites (already true on dev)

- GCS Fuse CSI driver: enabled ✓ · Workload Identity: enabled ✓ · cert-manager: ✓

## One-time setup

```bash
# 1. Build + push the image (project jax-cloud-image-tools, us-east1 AR)
gcloud artifacts repositories create jit-tile-example \
  --repository-format=docker --location=us-east1 --project=jax-cloud-image-tools
gcloud builds submit examples/tile-server \
  --tag us-east1-docker.pkg.dev/jax-cloud-image-tools/jit-tile-example/tile-server:v1 \
  --project jax-cloud-image-tools

# 2. Let the pod read the COG bucket (Workload Identity principal — no GSA)
gcloud storage buckets add-iam-policy-binding gs://jax-cimg-tile-cogs-use1 \
  --role=roles/storage.objectViewer \
  --member="principal://iam.googleapis.com/projects/940576874573/locations/global/workloadIdentityPools/jax-compsci-nc-dev-01.svc.id.goog/subject/ns/jit-tile-example/sa/tile-server"

# 3. DURABLE IMAGE PULL — a docker-registry pull secret from a jax-cloud-image-tools
#    SA key that has AR read (the deployment SA references it via imagePullSecrets).
kubectl -n jit-tile-example create secret docker-registry ar-pull \\
  --docker-server=us-east1-docker.pkg.dev --docker-username=_json_key \\
  --docker-password="$(cat <sa-key>.json)" \\
  --docker-email=svc-jax-cloud-image-tools@jax-cloud-image-tools.iam.gserviceaccount.com
```

> **Alternative (no secret, cleaner)** — grant the dev cluster node SA cross-project
> AR read; needs an Artifact Registry admin on jax-cloud-image-tools:
> `gcloud artifacts repositories add-iam-policy-binding jit-tile-example --location=us-east1 --project=jax-cloud-image-tools --member="serviceAccount:tf-gke-jax-cluster-dev-d21h@jax-compsci-nc-dev-01.iam.gserviceaccount.com" --role=roles/artifactregistry.reader`

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
