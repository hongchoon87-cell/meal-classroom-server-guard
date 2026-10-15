# Meal classroom server guard

An hourly, server-side health check and pause recovery guard for one existing Supabase Free project. It runs on a standard GitHub-hosted Ubuntu runner, independently of the classroom computer and ChatGPT approvals.

## Fixed scope

- Project: `gbfyekootswcelavkkpe` (`climate-bingo`).
- Site: https://green-meal-classroom-jw.dailybible-2026.chatgpt.site
- Ends at **2026-11-30 23:59:59 Asia/Seoul**. From `2026-11-30T15:00:00Z`, the guard makes no Supabase or classroom-site requests. The next scheduled run disables this workflow.
- The public repository contains only monitoring code. It contains no student records, teacher sessions, database password, Supabase recovery token, or application source.

## One-time secret setup

Create a **scoped** personal access token in [Supabase account tokens](https://supabase.com/dashboard/account/tokens): choose this project only and **Project Settings: Read-write** only. Do not grant database, Auth, storage, billing, organization-wide or account-wide permissions. Set an expiration covering the end date (December 1, 2026 if the form uses a date).

Save the token directly to this repository's **Settings → Secrets and variables → Actions → New repository secret**, with the name `SUPABASE_RECOVERY_TOKEN`. Do not paste the token into chat, code, a workflow input, or a public form. GitHub does not show the stored value again.

Project Settings Read-write is Supabase's smallest scope covering restoration, and also includes other project-setting operations. This guard's code only uses project detail reads and the fixed project's restore endpoint; it has no delete, pause, billing, provisioning, backup-rollback or data-change operation.

## What runs

The workflow runs at minute 17 of each hour during October and November. UTC and Korean time have the same minute. It has no paid runner, third-party action, dependency installation, cache, artifact upload or AI API call.

1. Read the fixed project's state through the Management API.
2. Request restore **once**, only when the state is `INACTIVE`.
3. Poll transitions with bounded read requests. An ambiguous restore response is never blindly retried.
4. Confirm `ACTIVE_HEALTHY`, the public page, a real WebP image and a fresh read-only database health RPC response.
5. Fail visibly on permissions, quota, network, recovery or application errors. Standard GitHub Actions failure notifications use the owner's GitHub notification settings.

Normal runs and completed restoration are visible in the Actions logs. This is periodic recovery, so an outage can last until a scheduled run plus recovery time. GitHub schedules may be delayed or dropped during high load. Neither free provider promises uninterrupted availability.

## Verification

Run `node --test` locally. Actions also runs those tests before exposing the recovery secret to the guard step.

Use **Actions → Meal classroom server guard → Run workflow → health-only** to check public page/image/DB from a GitHub-hosted server before the secret is registered. This does not prove Management API authentication or restoration permissions.

After registering the secret, run **recover** while the project is healthy. That verifies the real server credential and ordinary health path without deliberately pausing the classroom project. The actual paused-to-active path is tested with simulated HTTP responses, unless a real pause occurs naturally.

## Official references

- [Supabase scoped tokens and endpoint permissions](https://supabase.com/docs/guides/platform/personal-access-tokens)
- [Supabase project restore endpoint](https://supabase.com/docs/reference/api/v1-restore-a-project)
- [GitHub Actions free standard runners for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub schedule behavior and limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
