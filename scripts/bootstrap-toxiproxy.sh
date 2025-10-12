#!/bin/sh
set -euo pipefail

HOST="${TOXIPROXY_HOST:-toxiproxy:8474}"
LISTEN_ADDR="${TOXIPROXY_LISTEN:-0.0.0.0:8666}"
UPSTREAM_ADDR="${TOXIPROXY_UPSTREAM:-minio:9000}"
LATENCY_MS="${TOXIC_LATENCY_MS:-400}"
JITTER_MS="${TOXIC_JITTER_MS:-120}"
BANDWIDTH_BPS="${TOXIC_BANDWIDTH_BPS:-50000}"
PROXY_NAME="${TOXIPROXY_NAME:-minio_s3}"

echo "Bootstrapping Toxiproxy at ${HOST}..."

# Wait for Toxiproxy API to be available
attempt=0
until curl -fsS "http://${HOST}/version" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 60 ]; then
    echo "ERROR: Toxiproxy API did not become ready in time" >&2
    exit 1
  fi
  echo "Waiting for Toxiproxy... (${attempt}/60)"
  sleep 1
done

echo "Ensuring proxy '${PROXY_NAME}' exists..."
create_payload=$(printf '{"name":"%s","listen":"%s","upstream":"%s"}' \
  "${PROXY_NAME}" "${LISTEN_ADDR}" "${UPSTREAM_ADDR}")

# Try to create the proxy; ignore error if it already exists.
if ! curl -fsS -X POST "http://${HOST}/proxies" \
  -H "Content-Type: application/json" \
  -d "${create_payload}" >/dev/null 2>&1
then
  echo "Proxy already present; continuing."
fi

apply_toxic() {
  toxic_name="$1"
  toxic_type="$2"
  stream_dir="$3"
  attributes="$4"

  toxic_payload=$(printf '{"name":"%s","type":"%s","stream":"%s","attributes":%s}' \
    "${toxic_name}" "${toxic_type}" "${stream_dir}" "${attributes}")

  if curl -fsS -X POST "http://${HOST}/proxies/${PROXY_NAME}/toxics" \
    -H "Content-Type: application/json" \
    -d "${toxic_payload}" >/dev/null 2>&1
  then
    echo "Applied toxic '${toxic_name}'."
  else
    echo "Toxic '${toxic_name}' already exists or failed to apply; replacing..."
    # Delete and recreate to ensure updated settings.
    curl -fsS -X DELETE "http://${HOST}/proxies/${PROXY_NAME}/toxics/${toxic_name}" >/dev/null 2>&1 || true
    curl -fsS -X POST "http://${HOST}/proxies/${PROXY_NAME}/toxics" \
      -H "Content-Type: application/json" \
      -d "${toxic_payload}" >/dev/null
    echo "Re-applied toxic '${toxic_name}'."
  fi
}

latency_attrs=$(printf '{"latency":%s,"jitter":%s}' "${LATENCY_MS}" "${JITTER_MS}")
bandwidth_attrs=$(printf '{"rate":%s}' "${BANDWIDTH_BPS}")

apply_toxic "${PROXY_NAME}_latency_down" "latency" "downstream" "${latency_attrs}"
apply_toxic "${PROXY_NAME}_latency_up" "latency" "upstream" "${latency_attrs}"
apply_toxic "${PROXY_NAME}_bandwidth_down" "bandwidth" "downstream" "${bandwidth_attrs}"
apply_toxic "${PROXY_NAME}_bandwidth_up" "bandwidth" "upstream" "${bandwidth_attrs}"

echo "Toxiproxy bootstrap complete. Slow endpoint on ${LISTEN_ADDR}."
