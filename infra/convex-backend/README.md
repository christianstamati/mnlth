# Self-hosted Convex

A [Convex](https://docs.convex.dev/self-hosting) backend and dashboard, run locally with Docker Compose.

## Requirements

- Docker with the Compose plugin (`docker compose version`)

## Start the stack

This is the same compose file `index.ts` embeds into the EC2 instance, so what
runs locally is what runs deployed. From this directory:

```bash
docker compose up -d
```

This brings up two services:

| Service     | Default URL             | Notes                                          |
| ----------- | ----------------------- | ---------------------------------------------- |
| `backend`   | http://127.0.0.1:3210   | API. HTTP actions are served on port 3211.     |
| `dashboard` | http://127.0.0.1:6791   | Waits for the backend to report healthy.       |

The backend is healthy once `GET /version` responds; `docker compose ps` shows the status.

## Generate an admin key

The dashboard and the CLI both require an admin key:

```bash
docker compose exec backend ./generate_admin_key.sh
```

Paste the key into the dashboard login, or export it for the CLI:

```bash
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
export CONVEX_SELF_HOSTED_ADMIN_KEY='<key>'
npx convex dev
```

The key is a credential — keep it out of the repo. `.env` and `.env.*` are already gitignored.

## Configuration

Compose reads variables from a `.env` file in this directory. Ports and origins:

| Variable                     | Default                       |
| ---------------------------- | ----------------------------- |
| `PORT`                       | `3210`                        |
| `SITE_PROXY_PORT`            | `3211`                        |
| `DASHBOARD_PORT`             | `6791`                        |
| `CONVEX_CLOUD_ORIGIN`        | `http://127.0.0.1:$PORT`      |
| `CONVEX_SITE_ORIGIN`         | `http://127.0.0.1:$SITE_PROXY_PORT` |
| `NEXT_PUBLIC_DEPLOYMENT_URL` | `http://127.0.0.1:$PORT`      |

If you expose the backend beyond localhost, set the origin variables to the URL clients
actually reach, otherwise generated URLs will point at `127.0.0.1`.

Other defaults set in `docker-compose.yml`:

- `DOCUMENT_RETENTION_DELAY=172800` — document retention lowered to 2 days.
- `DISABLE_METRICS_ENDPOINT=true` — set to `false` for a Prometheus-compatible `/metrics`.
- `RUST_LOG=info`
- `APPLICATION_MAX_CONCURRENT_*=16` — mutation, query, V8 action, and Node action concurrency.
- `restart: unless-stopped` on both services — see below.

### Restarts

Both services run with `restart: unless-stopped`, so Docker brings a container back
after a crash and after the daemon starts (a reboot, or quitting and reopening Docker
Desktop). A container you stop yourself with `docker compose stop` stays stopped.

Restart policies react to the process exiting, not to the healthcheck below.

### Healthcheck

Only the `backend` service defines one. It runs inside that container every 5 seconds,
with a 10 second grace period on startup during which failures are not counted:

```yaml
healthcheck:
  test: curl -f http://localhost:3210/version
  interval: 5s
  start_period: 10s
```

`curl -f` turns an HTTP error status into a non-zero exit code, so a 5xx counts as a
failure rather than a successful fetch of an error page. Two unset defaults also apply:
`timeout: 30s` per probe and `retries: 3` consecutive failures before the status flips
to `unhealthy`. The response body is `unknown` on the `:latest` image — only the status
code matters.

The result is used for the dashboard's `depends_on: condition: service_healthy`, which
holds the dashboard back until the backend answers. Nothing else acts on it: Docker will
not restart an unhealthy container, so a backend that hangs without exiting stays up and
reports `unhealthy` indefinitely. Catching that needs an external watchdog.

Read the recorded result from the host:

```bash
docker compose ps                       # STATUS shows "Up 4 minutes (healthy)"
docker inspect convex-backend-backend-1 --format '{{.State.Health.Status}}'
docker inspect convex-backend-backend-1 --format '{{json .State.Health.Log}}'
```

The status is `starting`, `healthy`, or `unhealthy`, and the log keeps the last five
probes with exit codes and output. To make the request yourself instead, use the mapped
host port — `curl -f http://127.0.0.1:3210/version`. That is not the same URL the probe
uses: it depends on the `ports:` mapping, while the probe talks to the container's own
`localhost`.

### Storage

By default the backend keeps SQLite data and files in the `data` volume.

To use an external database instead, set `POSTGRES_URL` or `MYSQL_URL` (without a database
name in the URL) and `DO_NOT_REQUIRE_SSL=true` only if the server has no TLS.

To store files in S3, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and the
`S3_STORAGE_*` bucket variables. `S3_ENDPOINT_URL` and `AWS_S3_FORCE_PATH_STYLE=true` point
the backend at an S3-compatible service such as MinIO.

Set `INSTANCE_NAME` and `INSTANCE_SECRET` together to pin the instance identity across
restarts; leave both unset to let the backend generate them.

## Stop the stack

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and delete the data volume
```

`down -v` destroys the database and all stored files.

Use `docker compose stop` to stop the containers without removing them; the restart
policy will not bring them back until the next `docker compose start` or `up`.
