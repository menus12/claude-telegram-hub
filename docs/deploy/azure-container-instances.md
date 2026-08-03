# Deploy the hub to Azure Container Instances

The hub is a single always-on container. The **same image runs everywhere** — only the
environment differs (12-factor). ACI is a good fit for the outbound-long-poll Telegram adapter:
no inbound endpoint is required, just outbound reachability to Telegram.

> **One instance per bot token.** Exactly one process may run `getUpdates` for a token. Do **not**
> scale this to multiple replicas. Run a single container; let ACI restart it on failure.

## 1. Build and push the image

```sh
# to Azure Container Registry (ACR)
az acr login --name <registry>
docker build -t <registry>.azurecr.io/claude-telegram-hub:<tag> .
docker push <registry>.azurecr.io/claude-telegram-hub:<tag>
```

## 2. Create the container

Pass non-secret config as `--environment-variables` and secrets as
`--secure-environment-variables` (never baked into the image or logged):

```sh
az container create \
  --resource-group <rg> \
  --name claude-telegram-hub \
  --image <registry>.azurecr.io/claude-telegram-hub:<tag> \
  --registry-login-server <registry>.azurecr.io \
  --registry-username <user> --registry-password <pw> \
  --os-type Linux --cpu 1 --memory 1 \
  --restart-policy OnFailure \
  --ports 8787 \
  --environment-variables \
      HUB_ADAPTER=telegram \
      HUB_ALLOWLIST=<comma,separated,user,ids> \
      HUB_BIND_HOST=0.0.0.0 HUB_BIND_PORT=8787 \
  --secure-environment-variables \
      HUB_SESSION_SECRET=<secret> \
      TELEGRAM_BOT_TOKEN=<botfather-token>
```

- Prefer pulling secrets from **Azure Key Vault** into the deployment pipeline rather than passing
  them on the CLI.
- `HUB_BIND_HOST=0.0.0.0` is required so the hub is reachable; the image already defaults to it.

## 3. Reachability for sessions

Sessions attach over the session↔hub WebSocket at `TELEGRAM_HUB_URL`. Two topologies:

- **Remote hub (this ACI container):** expose port 8787 (ACI public IP/FQDN, or private VNet) and
  set the channel's `TELEGRAM_HUB_URL=wss://<hub-host>` behind TLS + your own auth/ingress. The
  `HUB_SESSION_SECRET` is the auth boundary — treat the endpoint as internet-facing.
- **Co-located hub:** if sessions run on the same host/VNet, point them at the private address.

## 4. Health

The container exposes `GET /healthz` (liveness) and `GET /readyz` (ready once the adapter has
started). The image also declares a Docker `HEALTHCHECK`; wire `/readyz` into your orchestration
probe if you front the hub with a load balancer.

## Version compatibility

The hub and the installed channel plugins version independently. A registration is rejected with
`version_mismatch` if the protocol majors differ — see
[../runbooks/operations.md](../runbooks/operations.md#protocol-version-compatibility). Upgrade the
hub image and the channel package together across a protocol-major bump.
