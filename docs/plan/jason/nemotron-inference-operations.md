# Nemotron inference — operational summary

Status: **provisioned and validated**. Owner: Jason. Instance: `revolutionary-fuchsia-clownfish` (Brev).

## What was provisioned

- **Instance:** `revolutionary-fuchsia-clownfish`, single NVIDIA A100-SXM4-80 GB GPU, 24 vCPU, 113 GB RAM, 92 GB boot disk (Ubuntu 22.04). Provider: Shadeform (SSH user `shadeform`). Public IP: `198.145.127.216`.
- **GPU driver:** NVIDIA 580.178.04 / CUDA 13.0 (upgraded from stock 550 so vLLM v0.27.1 could initialize the A100).
- **Serving stack:** Docker container `vllm/vllm-openai:v0.27.1`, host networking, bound to `127.0.0.1:8000` only (not reachable externally), restart policy `unless-stopped`.
- **Reverse proxy:** nginx on port 443 (TLS) + port 80 (HTTP→HTTPS redirect), Let's Encrypt certificate for `hackutd-26-llm.jasonaa.me`, bearer-token auth on `/v1/`, rate limit 10 r/s burst 20, request timeouts. Firewall (UFW) allows only 22/2222/80/443.
- **Model:** `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` (NVFP4 W4A16, single 80 GB GPU, reasoning parser `nemotron_v3`, tool-call parser `qwen3_coder`, auto tool choice enabled, max model len 4096, 64 max seqs, 0.90 GPU memory util). Model cache persisted at `~/.nemotron/models` (~21 GB).

## Delivered to the team

- **Base URL:** `https://hackutd-26-llm.jasonaa.me/v1`
- **Model name:** `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`
- **API key:** bearer key generated with `openssl rand -hex 32`, stored only in user-only file `~/.nemotron/api_key` (mode 600) on the instance. **Not committed, not logged, not printed.** Retrieval: `ssh` into the instance and `cat ~/.nemotron/api_key`, or read the file directly if you have box access.

## External validation (all passed, from outside the instance)

| Check | Result |
|---|---|
| Valid bearer key → `GET /v1/models` | HTTP 200, model listed |
| Valid bearer key → `POST /v1/chat/completions` | HTTP 200, completion returned (reasoning parser active) |
| Missing bearer key → `GET /v1/models` | HTTP 401, JSON auth error (auth header not logged) |
| Wrong bearer key → `GET /v1/models` | HTTP 401, JSON auth error |
| Direct reach of upstream `127.0.0.1:8000` from outside | Unreachable (loopback only) |
| TLS certificate | Valid, CN `jasonaa.me`, expires 2027-01-27 |

## Restart / recovery

- vLLM container: `docker restart nemotron-vllm` (restart policy `unless-stopped`; survives daemon restart, not host reboot unless Docker starts it).
- nginx: `sudo systemctl restart nginx` (enabled on boot).
- Model weights persist across container restarts in `~/.nemotron/models`; re-download only if the cache is cleared.

## Remaining items / risks

- **Billing cutoff (needs your confirmation):** instance started ~04:09 UTC Sat Nov 8. The plan calls for verifying the real billing start, the $60 credit, and the 20-hour cutoff, and whether Brev/Shadeform can schedule a safe stop or termination. A container stop or OS shutdown is not proof compute billing ends. Please check the Brev console and confirm, or tell me how to verify.
- **Disk:** actual boot disk is 92 GB (not the 250 GB estimate in the plan). The NVFP4 model cache is ~21 GB, leaving headroom, but monitor usage if you add more models or logs.
- **Single-instance, no HA:** if the instance is stopped/terminated, the endpoint is down. Restart the container and nginx to restore.
- **Key rotation:** to rotate, overwrite `~/.nemotron/api_key` and `docker restart nemotron-vllm` (nginx reads the key at start; restart nginx too if you change the map).

## Related files

- `docs/plan/jason/nemotron-inference-provisioning.md` — original plan
- `global_plan.md` §2 (hard rules) and §5 (contracts) respected; no team contracts, hardware config, or application logic modified.
- Nginx config: `/etc/nginx/conf.d/nemotron.conf` (on instance, not in repo — contains no secrets)
- Bearer key: `/home/shadeform/.nemotron/api_key` (on instance, mode 600, not in repo)

## Measured vs estimated

- Measured: single A100 serves the NVFP4 checkpoint; ~51.44 GiB KV cache available; model loads and responds; all external auth/TLS checks pass.
- Estimate: latency and throughput not yet benchmarked (plan requires no unmeasured claims).
