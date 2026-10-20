# Performance notes

The requirement is a `202` within 500 ms. This page has the numbers I measured and how to read them.

## Server time and network time

A request's total time is the network travel plus the work the server does. Every response carries a standard
`Server-Timing: app;dur=…` header with the application's own time in milliseconds (it leaves out the network and a
Lambda cold start), so the two can be told apart:

```bash
# the server's own time for this request
curl -si https://d2c87kyt7tmin7.cloudfront.net/ | grep -i server-timing

# the full breakdown as a client sees it
curl -s -o /dev/null https://d2c87kyt7tmin7.cloudfront.net/ \
  -w 'dns %{time_namelookup}s | tcp %{time_connect}s | tls %{time_appconnect}s | first byte %{time_starttransfer}s | total %{time_total}s\n'
```

The smoke and load tests print both figures. The smoke test fails on the server-side p95, and on the end-to-end p95
only if you pass `--strict-e2e`, because the end-to-end number also contains the distance between the test machine and
the server.

## Why CloudFront is in front

The Lambda runs in Sydney, the closest allowed region for my AWS account (see the deployment guide). A new HTTPS
connection needs about three round trips before the request is even sent, and one round trip from India to Sydney is
about 300 ms. Calling the Lambda URL directly from India therefore took about 0.98 s every time, even though the
function itself answered in tens of milliseconds.

CloudFront ends the HTTPS connection at an edge location near the caller (Delhi in my tests) and keeps its own
connections open to Sydney. A fresh connection dropped from about 0.98 s to about 0.4 s. It doesn't cache anything
(the managed `CachingDisabled` policy), it forwards every header except `Host`, and it allows POST. `curl -i` shows
which edge served you in the `X-Amz-Cf-Pop` header.

## Measured results

| Where | Result |
|---|---|
| Local dev server, 5 connections, 500 requests | all `202`; p50 31 ms, p95 59 ms, p99 66 ms, max 117 ms; about 140 req/s |
| Deployed on AWS, from India, smoke test through CloudFront | 19 of 19 checks pass. 35 requests: end-to-end p50 322 ms, p95 438 ms, p99 708 ms. Server's own time p50 21 ms, p95 137 ms. First request 388 ms. Processing finished 30.1 s after creation. |
| Same, load test: 120 requests over 4 reused connections | all `202`. Server's own time p50 20 ms, p95 56 ms. End to end p50 332 ms, p90 and p95 about 870 ms, max 2.3 s. |
| A brand-new HTTPS connection for every request, from India | Through CloudFront: webhook POSTs 0.36 to 0.46 s (8 of 8 under 500 ms); health checks 0.35 to 0.45 s in 4 of 6 runs and 0.89 s in 2 of 6. Direct to the Lambda URL: 0.97 to 0.99 s every time (the TCP and TLS handshakes alone take 0.65 s). |
| Earlier, from a GitHub Actions runner, direct to Lambda (before CloudFront) | server's own p95 137 ms, end-to-end p95 599 ms; the first request (a cold Lambda plus a new connection) took 809 ms |

Local numbers only show that the application code is fast. They don't predict AWS latency.

## What is still slow

- **Cold start.** The first request to a cold Lambda also pays for starting the function and opening the database
  connection. To limit this the database is in the same region as the Lambda, the bundle is small, a warm-up ping runs
  every 5 minutes and each container reuses one connection. Provisioned concurrency would remove it but isn't free.
- **A tail of slow requests from far away.** About one request in ten (the load test's p90 and p95 were around 870 ms)
  is one where CloudFront has to open a new connection to Sydney first, which costs about 0.9 s. The application's own
  time stays at tens of milliseconds. Steady traffic keeps CloudFront's origin connections warm, so this mostly affects
  sparse, bursty traffic. I haven't tried CloudFront Origin Shield, which costs money and may not help POST requests.
- **The acknowledgement waits for the database and the queue.** That's on purpose: nothing is acknowledged unless it is
  saved. If cold starts turned out too slow, the alternative would be to queue first and let the worker write to the
  database.
- **New AWS accounts** can be limited to about 10 concurrent Lambda executions in total. Worker concurrency is capped
  at 5 to leave room for the API, and the load test should use a small `--connections` value.

## Load test

Every request creates a real transaction, so keep the numbers modest:

```bash
npm run load-test -- --url https://d2c87kyt7tmin7.cloudfront.net --connections 5 --requests 300
```
