# Running the classifier on SAP AI Core (free tier)

Everything in `docs/MODEL.md` works with no cloud at all: Python trains on your
laptop, `weights.json` lands in the repo, TypeScript does inference in-process.
This document is about doing the same two jobs — **training** and **serving** —
on SAP AI Core instead, and pointing the app at the result with
`CLASSIFIER_URL`, `CLASSIFIER_TOKEN` and `CLASSIFIER_RESOURCE_GROUP`.

**Be honest about why you would.** The local classifier is faster (microseconds
vs. a network round trip), free, and cannot be down. AI Core buys you two real
things: retraining that does not need your laptop awake, and the ability to say
"the model runs on SAP AI Core" and then show the deployment. The second reason
is a perfectly good reason for this particular project. The app is built so that
switching costs one environment variable and switching back costs deleting it.

The templates belong in `ml/aicore/`. That directory ships empty: AI Core reads
the YAML out of a **Git repository** (§5), so the files only become useful once
you have decided which repo it may see. §4, §5.1 and §5.2 below are the source
for `Dockerfile`, `training-template.yaml` and `serving-template.yaml` — create
them from those listings when you take this path, and skip it entirely otherwise.

---

## 0. Two paths, pick the cheap one first

|                            | **A — serving only**                   | **B — training + serving**                    |
| -------------------------- | -------------------------------------- | --------------------------------------------- |
| Model comes from           | `weights.json` baked into the image    | an AI Core execution writing a model artifact |
| Needs an object store (S3) | **no**                                 | **yes**                                       |
| Free-tier friendly         | yes                                    | yes, but you supply the bucket                |
| Retraining                 | on your laptop, then rebuild the image | `POST /v2/lm/executions`                      |

Path A is §1–§6 and is where to start: the failure modes (image architecture,
resource group headers, token expiry) are the same, and you hit them without
also debugging artifact bindings. Path B adds §7.

---

## 1. Entitlement and instance

1. BTP cockpit → your subaccount → **Entitlements** → _Configure Entitlements_ →
   _Add Service Plans_.
2. Search **SAP AI Core**. Pick the plan you are entitled to:
   - `free` on a pay-as-you-go / free-tier account,
   - `standard` on a trial (the trial's standard plan is the free allowance).
     Add it, **Save**.
3. **Services → Service Marketplace** → _SAP AI Core_ → **Create**:
   plan as above, instance name `twoway-aicore`, runtime **Cloud Foundry** (or
   _Other_ — this app talks to the AI API over HTTPS, it is not bound to a CF
   app).
4. **Services → Instances and Subscriptions** → _Instances_ → `twoway-aicore` →
   **⋮ → Create Service Key**, name it `twoway-aicore-key`, then **View**.

Optional but useful: also subscribe to **SAP AI Launchpad** (Service Marketplace
→ _SAP AI Launchpad_ → _Create_ → plan `standard`/`free`, then _Subscriptions_ →
_Go to Application_, and connect it to your AI Core instance). Everything below
can be done from the Launchpad UI instead of curl; the curl is here because it
is unambiguous and copy-pasteable.

### The service key

```jsonc
{
  "serviceurls": {
    "AI_API_URL": "https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com",
  },
  "appname": "…",
  "clientid": "sb-example!b1|aicore!b2",
  "clientsecret": "•••••••••••",
  "identityzone": "example-trial",
  "url": "https://example-trial.authentication.eu10.hana.ondemand.com",
}
```

| Field                       | Used for                                   |
| --------------------------- | ------------------------------------------ |
| `serviceurls.AI_API_URL`    | base of every `/v2/...` call below         |
| `url`                       | XSUAA token endpoint (`{url}/oauth/token`) |
| `clientid` / `clientsecret` | client-credentials grant                   |

This whole JSON, on **one line**, is also what `AICORE_SERVICE_KEY` holds when
you use the generative AI hub for the "Statement of Us"
(`docs/CONTRACTS.md` §7, provider 3). Same key, two unrelated uses — the hub path
reads it plus `AICORE_MODEL`, `AICORE_RESOURCE_GROUP` and the optional
`AICORE_DEPLOYMENT_ID`, and finds the orchestration deployment itself; the
classifier path in this document uses none of those and takes a plain URL and
token instead.

### Token

```bash
export AICORE_URL=https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com
TOKEN=$(curl -s -u "$CLIENTID:$CLIENTSECRET" \
  -d grant_type=client_credentials \
  "https://example-trial.authentication.eu10.hana.ondemand.com/oauth/token" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
```

It is valid for roughly 12 hours. Remember that; §6 is about nothing else.

---

## 2. Register a resource group

A resource group is AI Core's tenant boundary. **Every** `/v2/lm/*` call and
every inference request carries `AI-Resource-Group`, and the error for getting it
wrong is a 403 that looks exactly like an auth problem.

```bash
curl -s -X POST "$AICORE_URL/v2/admin/resourceGroups" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resourceGroupId":"twoway"}'

curl -s "$AICORE_URL/v2/admin/resourceGroups" -H "Authorization: Bearer $TOKEN"
```

Creation is asynchronous — the group shows `PROVISIONING` for a minute before
`PROVISIONED`, and calls against it 403 until then. **On the free tier the
create may be refused** (403/400, "not allowed for this plan"): free plans are
frequently limited to the built-in `default` group. That is fine. Use `default`
everywhere and set `CLASSIFIER_RESOURCE_GROUP=default`. Nothing in this document
depends on a custom group beyond tidiness.

From here on:

```bash
export RG=twoway    # or: default
alias aic='curl -s -H "Authorization: Bearer $TOKEN" -H "AI-Resource-Group: $RG"'
```

---

## 3. Docker registry secret

AI Core pulls your image; it needs credentials even for a public Docker Hub repo
(it will not do anonymous pulls).

```bash
curl -s -X POST "$AICORE_URL/v2/admin/dockerRegistrySecrets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "name": "twoway-docker",
        "data": { ".dockerconfigjson": "{\"auths\":{\"docker.io\":{\"username\":\"YOUR_USER\",\"password\":\"YOUR_DOCKERHUB_ACCESS_TOKEN\"}}}" }
      }'
```

The `.dockerconfigjson` value is a **string containing JSON**, escaped — not a
nested object. The name (`twoway-docker`) is what the templates reference under
`imagePullSecrets`. Use a Docker Hub _access token_, never your account password.

---

## 4. Build the image — `--platform linux/amd64`

```dockerfile
# ml/aicore/Dockerfile — build from the repo root: docker build -f ml/aicore/Dockerfile .
FROM python:3.11-slim
WORKDIR /app
COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Only the sources, one glob, no directories: `COPY ml/ /app/` would drag in
# ml/.venv (a macOS virtualenv, useless and large in a linux image), ml/data/ and
# the 7 MB ml/model/model.pkl, which the container never opens.
COPY ml/*.py /app/
# Path A: ship the trained model inside the image. Path B mounts it at
# /mnt/models instead and this line is dropped.
COPY ml/model/weights.json /app/model/weights.json
RUN useradd -u 10001 -m appuser && chown -R appuser /app
USER 10001
EXPOSE 9001
# No --weights: serve.py defaults to <script dir>/model/weights.json, which is
# exactly where the COPY above put it.
CMD ["python", "serve.py", "--host", "0.0.0.0", "--port", "9001"]
```

`ml/serve.py` deliberately has no web framework — it is `http.server` from the
standard library, because one route and one JSON body do not justify a
dependency, and a smaller image is a faster cold start. Nothing to `pip install`
beyond what the trainer already needs.

```bash
docker build --platform linux/amd64 \
  -f ml/aicore/Dockerfile \
  -t docker.io/YOUR_USER/twoway-classifier:1.0.0 .
docker push docker.io/YOUR_USER/twoway-classifier:1.0.0
```

**`--platform linux/amd64` is not optional and it is not a warning you can
ignore.** On an Apple Silicon Mac, `docker build` produces an `arm64` image by
default. AI Core's nodes are `amd64`. The image pushes happily, the deployment
goes to `PENDING`, and then — with no build error anywhere — the pod dies with
`exec format error` or `no matching manifest for linux/amd64`, visible only in
the deployment logs. Hours have been lost here. If you already pushed an arm64
image, rebuild with the flag and push a **new tag**: AI Core caches by tag and
re-pushing `:1.0.0` may not be re-pulled.

Sanity check before you push:

```bash
docker image inspect docker.io/YOUR_USER/twoway-classifier:1.0.0 \
  --format '{{.Os}}/{{.Architecture}}'      # must print linux/amd64
```

`ml/serve.py` exposes the contract from `docs/CONTRACTS.md` §5:

| Route                            | Purpose                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /classify` (also `POST /`) | `{merchantRaw, amount, whenISO}` → a `ClassifyResult`, camelCase keys, probabilities rounded to 6 decimals |
| `GET /health` (also `GET /`)     | readiness — KServe uses it to decide when the deployment is `RUNNING`                                      |

Flags: `--host` (default `127.0.0.1`, so **always** pass `0.0.0.0` in a
container), `--port` (default `8088`) and `--weights` (default
`ml/model/weights.json`).

---

## 5. Templates and onboarding the Git repo

AI Core does not accept templates over the API. It **syncs them from a Git
repository**: you register the repo once, register an "application" that points
at a folder in it, and AI Core polls that folder for scenario templates.

```bash
curl -s -X POST "$AICORE_URL/v2/admin/repositories" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"twoway-ml","url":"https://github.com/YOUR_USER/YOUR_REPO",
       "username":"YOUR_USER","password":"YOUR_GITHUB_PAT"}'

curl -s -X POST "$AICORE_URL/v2/admin/applications" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationName":"twoway-ml","repositoryUrl":"https://github.com/YOUR_USER/YOUR_REPO",
       "revision":"HEAD","path":"ml/aicore"}'

# after a minute
aic "$AICORE_URL/v2/admin/applications/twoway-ml/status"
aic "$AICORE_URL/v2/lm/scenarios"
```

Consequence worth stating plainly: **this repo has to be pushed to GitHub for AI
Core to see the templates.** It is a private repo about a household's spending.
Either keep only `ml/aicore/` in a separate public-ish repo, or use a private
repo with a fine-grained PAT scoped to that one repository, read-only.

### 5.1 `ml/aicore/training-template.yaml`

An Argo `WorkflowTemplate`. The labels are not decoration — AI Core reads
`scenarios.ai.sap.com/id` and `executables.ai.sap.com/id` to build the scenario
list, and a template missing one of them is silently ignored.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: twoway-train
  annotations:
    scenarios.ai.sap.com/name: 'Two-Way Match classifier'
    executables.ai.sap.com/name: 'twoway-train'
    artifacts.ai.sap.com/transactions.kind: 'dataset'
    artifacts.ai.sap.com/model.kind: 'model'
  labels:
    scenarios.ai.sap.com/id: 'twoway-match'
    executables.ai.sap.com/id: 'twoway-train'
    ai.sap.com/version: '1.0.0'
spec:
  imagePullSecrets:
    - name: twoway-docker
  entrypoint: train
  arguments:
    parameters:
      - name: N_BUCKETS
        value: '65536'
  templates:
    - name: train
      metadata:
        labels:
          ai.sap.com/resourcePlan: starter # the only free-tier plan (CPU)
      inputs:
        artifacts:
          - name: transactions
            path: /app/data
      outputs:
        artifacts:
          - name: model
            globalName: model
            path: /app/model
            archive:
              none: {}
      container:
        image: docker.io/YOUR_USER/twoway-classifier:1.0.0
        command: ['/bin/sh', '-c']
        args:
          - >-
            python train.py --csv /app/data/transactions.csv
            --n-buckets {{workflow.parameters.N_BUCKETS}}
            --out /app/model/model.pkl &&
            python export_ts.py --model /app/model/model.pkl
            --csv /app/data/transactions.csv
            --weights /app/model/weights.json
            --fixture /app/model/parity_fixture.json
```

Both scripts take explicit paths (`train.py`: `--csv --n-buckets --out
--test-size --seed`; `export_ts.py`: `--model --csv --weights --fixture`), which
is what makes them usable from a workflow at all — nothing is resolved relative
to a working directory you do not control. The output artifact therefore contains
**both** `weights.json` and `parity_fixture.json`, and the fixture is the half
you must bring home (§7).

`archive: none: {}` matters: without it Argo tars the output directory and the
serving side gets `model.tgz` instead of `weights.json`.

### 5.2 `ml/aicore/serving-template.yaml`

A `ServingTemplate` wrapping a KServe `InferenceService`. Note that `metadata`,
`labels` and `spec` inside `template` are **strings** (`|`), not YAML maps —
that is the ServingTemplate schema, and getting it wrong yields an unhelpful
"invalid template" on sync.

```yaml
apiVersion: ai.sap.com/v1alpha1
kind: ServingTemplate
metadata:
  name: twoway-serve
  annotations:
    scenarios.ai.sap.com/name: 'Two-Way Match classifier'
    executables.ai.sap.com/name: 'twoway-serve'
  labels:
    scenarios.ai.sap.com/id: 'twoway-match'
    executables.ai.sap.com/id: 'twoway-serve'
    ai.sap.com/version: '1.0.0'
spec:
  inputs:
    artifacts:
      - name: model # Path B only; omit for a model baked into the image
  template:
    apiVersion: 'serving.kserve.io/v1beta1'
    metadata:
      annotations: |
        autoscaling.knative.dev/metric: concurrency
        autoscaling.knative.dev/target: '1'
        autoscaling.knative.dev/targetBurstCapacity: '0'
      labels: |
        ai.sap.com/resourcePlan: starter
    spec: |
      predictor:
        imagePullSecrets:
          - name: twoway-docker
        minReplicas: 1
        maxReplicas: 1
        containers:
          - name: kserve-container
            image: 'docker.io/YOUR_USER/twoway-classifier:1.0.0'
            ports:
              - containerPort: 9001
                protocol: TCP
            command: ['python', 'serve.py']
            # Path B: KServe stages the model artifact at /mnt/models.
            # For Path A drop --weights and the STORAGE_URI env entirely.
            args: ['--host', '0.0.0.0', '--port', '9001',
                   '--weights', '/mnt/models/weights.json']
            env:
              - name: STORAGE_URI
                value: '{{inputs.artifacts.model}}'
```

`minReplicas: 1` with `targetBurstCapacity: 0` keeps the pod warm. Scale-to-zero
sounds thrifty and is wrong here: the first classification after a cold start
waits for a container pull, the app's remote call times out, and the fallback in
`classify()` quietly serves a local result — so the deployment you are paying
attention to is never actually used.

### 5.3 Configuration → deployment

```bash
# 1. a configuration binds an executable to parameter/artifact values
CFG=$(aic -X POST "$AICORE_URL/v2/lm/configurations" \
  -H 'Content-Type: application/json' \
  -d '{"name":"twoway-serve-cfg","executableId":"twoway-serve","scenarioId":"twoway-match"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. a deployment runs it
DEP=$(aic -X POST "$AICORE_URL/v2/lm/deployments" \
  -H 'Content-Type: application/json' \
  -d "{\"configurationId\":\"$CFG\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 3. wait for RUNNING and read the URL
aic "$AICORE_URL/v2/lm/deployments/$DEP"
```

The response carries `status` (`PENDING` → `RUNNING`, or `DEAD`) and, once
running, `deploymentUrl`. Logs while it starts:
`GET /v2/lm/deployments/$DEP/logs`.

Smoke test it before touching `.env`:

```bash
curl -s -X POST "$DEPLOYMENT_URL/classify" \
  -H "Authorization: Bearer $TOKEN" \
  -H "AI-Resource-Group: $RG" \
  -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"RESTAURANT BLAUE ENTE","amount":148.5,"whenISO":"2026-03-14T20:15"}'
```

You want `Dining` / `date_night` back, with the same probabilities the local
model gives — literally the same model, so any difference is a bug in the
serving container, not in the cloud.

---

## 6. Point the app at it

```dotenv
CLASSIFIER_URL=https://<deploymentUrl>/classify
CLASSIFIER_TOKEN=<the bearer token from §1>
CLASSIFIER_RESOURCE_GROUP=twoway
```

`classify()` then POSTs `{merchantRaw, amount, whenISO}` there, sends
`Authorization: Bearer ${CLASSIFIER_TOKEN}` and `AI-Resource-Group:
${CLASSIFIER_RESOURCE_GROUP}`, and returns the parsed result with
`engine: 'remote'` (`docs/CONTRACTS.md` §5). Unset `CLASSIFIER_URL` and it is
local again. No code change, no rebuild.

**The honest note about `CLASSIFIER_TOKEN`:** it is an XSUAA client-credentials
token and it expires in about 12 hours. The app does not refresh it, by design —
it holds no AI Core credentials, only a token someone hands it. So a static value
in `.env` works for a demo and goes stale overnight. When it does, every remote
call 401s, `classify()` logs a warning and falls back to local inference, and
the app keeps working with `engine: 'local'` — which is the correct behaviour and
also the reason you might not notice for a week. Watch `engine` in the response
if you care.

If you want it to keep working unattended, the fix is to teach the classifier
client to mint its own token from `AICORE_SERVICE_KEY` and cache it with an
expiry, the way `srv/lib/documentai/client.ts` already does. That is a
deliberate future change, not an accident: today the contract is "a token in an
env var".

---

## 7. Path B: training on AI Core

Adds one prerequisite the free tier does not give you: **object storage**.
Datasets go in, model artifacts come out, and AI Core reaches both through an
object store secret — an S3 bucket you own (AWS free tier is enough) or a BTP
Object Store instance (not free).

```bash
curl -s -X POST "$AICORE_URL/v2/admin/objectStoreSecrets" \
  -H "Authorization: Bearer $TOKEN" -H "AI-Resource-Group: $RG" \
  -H 'Content-Type: application/json' \
  -d '{"name":"default","type":"S3","bucket":"twoway-ml","region":"eu-central-1",
       "endpoint":"s3-eu-central-1.amazonaws.com","pathPrefix":"twoway",
       "data":{"AWS_ACCESS_KEY_ID":"…","AWS_SECRET_ACCESS_KEY":"…"}}'
```

The secret **must** be named `default` if your templates refer to artifacts
without a secret name. Then:

1. `npm run ml:export-data` locally, upload `ml/data/live_transactions.csv` to
   `s3://twoway-ml/twoway/data/`.
2. Register it as an artifact:
   `POST /v2/lm/artifacts` with `{"name":"transactions","kind":"dataset",
"url":"ai://default/data","scenarioId":"twoway-match"}`.
3. Create a configuration for `twoway-train` with an
   `inputArtifactBindings: [{"key":"transactions","artifactId":"<id>"}]` and
   `parameterBindings: [{"key":"N_BUCKETS","value":"65536"}]`.
4. `POST /v2/lm/executions` with that configuration id; poll
   `GET /v2/lm/executions/{id}` until `COMPLETED`. The output artifact id is in
   the response.
5. Feed that artifact id to the serving configuration's `inputArtifactBindings`
   and create a new deployment (or `PATCH` the existing one with the new
   configuration id for a rolling update).

**Then download `weights.json` _and_ `parity_fixture.json` from the bucket,
commit both, and run `npm test` locally.** A model trained in the cloud that has
never faced `test/classifier-parity.test.ts` is a model you cannot ship to the
local inference path — and the local path is the one that runs when the token
expires. The cloud does not get to skip the contract.

---

## 8. Troubleshooting

| Symptom                                                                 | Cause                                                                                                              | Fix                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403` on every `/v2/lm/*` call                                          | missing or wrong `AI-Resource-Group` header                                                                        | Send it on every `lm` and inference call. It is not derived from the token.                                                                                                                        |
| `403` creating a resource group                                         | free plan restricts resource groups                                                                                | Use `default`; set `CLASSIFIER_RESOURCE_GROUP=default`.                                                                                                                                            |
| `GET /v2/lm/scenarios` is empty after onboarding the repo               | template labels missing/misspelled, or the `path` in the application does not point at the folder holding the YAML | Check `/v2/admin/applications/twoway-ml/status` for the sync error; confirm `scenarios.ai.sap.com/id` and `executables.ai.sap.com/id` labels exist.                                                |
| Deployment reaches `RUNNING` then `DEAD`, logs show `exec format error` | arm64 image on amd64 nodes                                                                                         | Rebuild with `--platform linux/amd64`, push a **new tag**, new configuration, new deployment.                                                                                                      |
| Deployment stuck `PENDING`, logs show `ImagePullBackOff`                | docker registry secret missing, wrong name, or `.dockerconfigjson` not an escaped string                           | Recreate the secret; check `imagePullSecrets.name` in both templates matches it.                                                                                                                   |
| Deployment `RUNNING` but every request times out                        | container not listening on the port declared in `containerPort`, or bound to `127.0.0.1`                           | Bind `0.0.0.0`, match the port exactly.                                                                                                                                                            |
| App logs "remote classifier failed, falling back"                       | expired `CLASSIFIER_TOKEN`, deployment scaled to zero, or a network hiccup                                         | Mint a fresh token (§1). Confirm `minReplicas: 1`. The app is working correctly — this is the fallback doing its job.                                                                              |
| Remote and local disagree on probabilities                              | the container has a different `weights.json` than the repo                                                         | Rebuild the image from the committed `weights.json` and re-run the parity test. `docs/CONTRACTS.md` §4 is the arbiter.                                                                             |
| Execution `COMPLETED` but the serving pod cannot find `weights.json`    | Argo archived the output directory                                                                                 | `archive: none: {}` on the output artifact; check the `--weights` argument in the serving template points at KServe's staging path (`/mnt/models/weights.json`), not at the image's `/app/model/`. |
| Everything 401s after 12 hours                                          | token expiry, as designed                                                                                          | §6.                                                                                                                                                                                                |
