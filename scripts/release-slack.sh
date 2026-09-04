#!/usr/bin/env bash
# Turn a GitHub Release into a Slack message and post it to the webhook.
# Usage: TAG=v1.0.0 URL=https://... BODY="$(release notes)" WEBHOOK=... release-slack.sh
set -euo pipefail

# release-please writes GitHub markdown; Slack wants its own. Drop the
# leading "## 1.0.0 (date)" line since the card already shows the tag, then
# translate headings, bold, bullets and links.
notes=$(printf '%s\n' "$BODY" \
  | sed -E '1{/^#+ /d;}' \
  | sed -E 's/^#+ +(.*)$/*\1*/; s/\*\*([^*]+)\*\*/*\1*/g; s/^\* /•  /; s/\[([^]]+)\]\(([^)]+)\)/<\2|\1>/g' \
  | sed -E '/./,$!d' \
  | head -c 2900)

jq -n --arg tag "$TAG" --arg url "$URL" --arg notes "$notes" --arg repo "$REPO" '{
  text: "\($repo) \($tag) released: \($url)",
  attachments: [{
    color: "#E8A33D",
    blocks: [
      { type: "section",
        text: { type: "mrkdwn", text: ":rocket:  *<\($url)|\($tag)>*" },
        accessory: { type: "button", text: { type: "plain_text", text: "Changelog" }, url: $url } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: $notes } }
    ]
  }]
}' | curl -sS -f -X POST -H 'Content-type: application/json' --data @- "$WEBHOOK"
echo
