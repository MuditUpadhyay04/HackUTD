# Nemotron inference — runbook

Status: **provisioned and validated**. Owner: Jason. Instance: `revolutionary-fuchsia-clownfish` (Brev).

## Delivered to the team

| Item | Value |
|---|---|
| **Base URL** | `https://hackutd-26-llm.jasonaa.me/v1` |
| **Model name** | `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` |
| **API key** | bearer key in `~/.nemotron/api_key` (mode 600) on the instance |

**Retrieve the API key:**
```
brev shell revolutionary-fuchsia-clownfish
cat ~/.nemotron/api_key
```
The key is generated with `openssl rand -hex 32`, stored only in the user-only file on the instance. It is **not committed, not logged, not printed**.

## What was provisioned

- **Instance:** `revolutionary-fuchsia-clownfish`, NVIDIA A100 (80 GB), 1 GPU × 24 CPUs, 116 GB RAM, 2125 GB disk (Brev console), public IP `198.145.127.216` (Houston, TX). SSH user `shadeform`. Hostname `brev-ijoki5gku`.
- **GPU driver:** NVIDIA 580.178.04 / CUDA 13.0 (upgraded from stock 550 so vLLM v0.27.1 could initialize the A100).
- **Serving stack:** Docker container `vllm/vllm-openai:v0.27.1`, host networking, bound to `127.0.0.1:8000` only (loopback, not reachable externally), restart policy `unless-stopped`.
- **Reverse proxy:** nginx on port 443 (TLS) + port 80 (HTTP→HTTPS redirect), Let's Encrypt certificate for `hackutd-26-llm.jasonaa.me` (valid to 2027-01-27), bearer-token auth on `/v1/`, rate limit 10 r/s burst 20, request timeouts. Firewall (UFW) allows only 22/2222/80/443.
- **DNS:** `hackutd-26-llm.jasonaa.me` → `198.145.127.216` (Cloudflare proxy left ON for DDoS/WAF protection and origin IP hiding).
- **Model:** `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` (NVFP4 W4A16, single 80 GB GPU, reasoning parser `nemotron_v3`, tool-call parser `qwen3_coder`, auto tool choice enabled, max model len 4096, 64 max seqs, 0.90 GPU memory util). Model cache persisted at `~/.nemotron/models` (~21 GB).

**Model selection rationale:** The plan preferred Nemotron 3.5 Lightning on a single A100; Bolt/Super were considered but not needed. The A100 (80 GB) holds the NVFP4 checkpoint with headroom for KV cache.

## External validation (all passed, from outside the instance)

| Check | Result |
|---|---|
| Valid bearer key → `GET /v1/models` | HTTP 200, model listed |
| Valid bearer key → `POST /v1/chat/completions` | HTTP 200, completion returned (reasoning parser active) |
| Missing bearer key → `GET /v1/models` | HTTP 401, JSON auth error (auth header not logged) |
| Wrong bearer key → `GET /v1/models` | HTTP 401, JSON auth error |
| Direct reach of upstream `127.0.0.1:8000` from outside | Unreachable (loopback only) |
| TLS certificate | Valid, CN `jasonaa.me`, expires 2027-01-27 |

## Billing (confirmed via Brev console)

- **Burn rate:** `$1.80/hr`
- **Credits left:** `31.9 hrs` (~$57.51)
- **20-hour cutoff:** ~$36 — covered with margin
- **Instance created:** 11/7/2026, 10:01:05 PM

A container stop or OS shutdown is not proof compute billing ends. To guarantee cost control, stop or terminate the instance from the Brev console when the demo is complete.

## Restart / recovery

- vLLM container: `docker restart nemotron-vllm` (restart policy `unless-stopped`; survives daemon restart).
- nginx: `sudo systemctl restart nginx` (enabled on boot).
- Model weights persist across container restarts in `~/.nemotron/models`; re-download only if the cache is cleared.
- Full instance stop/termination: use the Brev console (Stop / Delete buttons on the instance page).

## Key rotation

To rotate, overwrite `~/.nemotron/api_key` on the instance, then `docker restart nemotron-vllm` and `sudo systemctl restart nginx` (nginx reads the key at start).

## Related files

- `docs/plan/jason/nemotron-inference-provisioning.md` — original plan
- `global_plan.md` §2 (hard rules) and §5 (contracts) respected; no team contracts, hardware config, or application logic modified.
- Nginx config: `/etc/nginx/conf.d/nemotron.conf` (on instance, not in repo — contains no secrets)
- Bearer key: `/home/shadeform/.nemotron/api_key` (on instance, mode 600, not in repo)

## Measured vs estimated

- Measured: single A100 serves the NVFP4 checkpoint; ~51.44 GiB KV cache available; model loads and responds; all external auth/TLS checks pass.
- Estimate: latency and throughput not yet benchmarked (plan requires no unmeasured claims).
