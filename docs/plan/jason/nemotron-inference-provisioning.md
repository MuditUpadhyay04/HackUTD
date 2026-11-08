# Nemotron inference provisioning

Status: **planned; instance not provisioned**. Owner: Jason. This is an operational handoff, not a change to the server/dashboard contracts in `global_plan.md`.

## Goal

Provision the Brev GPU instance after Jason supplies SSH access. Deliver an OpenAI-compatible inference API base URL, model name, and API key that the team can use from multiple devices, without Tailscale. Ask Jason when a decision or access is needed; do not expose credentials in chat, logs, git, or other public artifacts.

## Constraints and decisions

- Target Nemotron 3.5 Super VL 120B-A12B NVFP4 on a single RTX PRO 6000 96 GB. Start from the [vLLM model-specific RTX PRO 6000 recipe](https://recipes.vllm.ai/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4); confirm the GPU, driver, memory, and actual compatibility. The model's [NVIDIA NIM guide](https://docs.nvidia.com/nim/large-language-models/2.0.13/get-started/advanced/get-started-nemotron-3.5-super-vl.html) lists two of these GPUs for its NIM profile, despite single-GPU vLLM support in the [model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4).
- Use a subdomain of `jasonaa.me` with publicly trusted HTTPS. Choose the hostname and obtain DNS access or request the necessary DNS record from Jason. Do not assume control of DNS or expose an unauthenticated service while configuring it.
- Keep the inference server bound to loopback. Expose only an HTTPS reverse proxy or gateway with a strong generated bearer API key on all inference routes. Restrict firewall and cloud ingress while preserving SSH and existing services. Deny absent and invalid credentials; do not log authorization headers. Add conservative request and rate limits where feasible.
- The 250 GB main disk is a reasonable starting estimate, not a tested guarantee: the model repository is approximately 75 GB, and container images, caches, OS, logs, and possible duplicate downloads require extra space. Verify actual free space and mount location; avoid duplicate checkpoints.
- The $60 credit is intended for at most 20 hours. Determine the real billing start and cutoff, credit eligibility, and any additional charges. Arrange a verified provider-side stop or termination if supported and authorized. A container stop or OS shutdown is not proof that compute billing ends. Ask Jason if automated cutoff is unavailable or would destroy needed data.
- Do not modify team contracts, hardware configuration, or application logic as part of this task. Respect `global_plan.md` sections 2 and 5; recommendations and what-if results must remain separate from actual equipment control.

## Execution

1. Verify SSH host identity, access, existing services, hardware, GPU visibility, free disk, network reachability, and provider billing controls. Install only missing prerequisites; avoid replacing user data or blocking SSH.
2. Deploy a pinned, restartable inference service with a persistent model cache, limited initial context and concurrency, and supported tool-call/reasoning parsers. Test before tuning. Use the documented recipe for the actual hardware; benchmark any acceleration rather than claim an unmeasured speedup.
3. Configure DNS and a valid certificate, then add the authenticated HTTPS gateway. Do not send the API key over plaintext. Store it only in a restricted machine-local secret file or secret manager. Never commit it.
4. Test from outside the instance: trusted TLS, valid-key completion, valid tool-call round trip, failure for missing and incorrect keys, and inability to reach the upstream directly. Confirm restart behavior, GPU memory, disk usage, and response latency. Do not report success if these checks fail.
5. Provide the URL ending in `/v1`, model name, secure key delivery or retrieval instructions, and operational status/restart information. If no private outbound secret channel is available, store the key in a user-only file on the instance and give Jason a secure retrieval method. Explain remaining risks and the verified billing cutoff.
6. Commit any repo changes made for this work and a sanitized operational summary under `docs/plan/jason/`, then push as requested. The summary must accurately distinguish measured results from estimates and never contain keys, tokens, private credentials, or unnecessary host-specific sensitive data. Inspect git status and stage only this task's files; preserve other people's work. If push or branch policy blocks the work, report the blocker instead of force pushing.

## Pending input

- Instance IP, SSH user/port and trusted host fingerprint or existing trusted SSH configuration.
- Preferred subdomain and DNS access or a person who can add the record.
- Instance billing start and whether the provider can schedule a safe stop or termination.
