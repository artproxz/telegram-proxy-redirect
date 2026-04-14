name: Fetch Telegram Proxies

on:
  schedule:
    - cron: '*/10 * * * *'  # Каждые 10 минут
  workflow_dispatch:        # Ручной запуск

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  fetch:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

    steps:
      - uses: actions/checkout@v4  # ✅ v4 — стабильная версия
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Fetch proxies
        run: node fetch-proxies.js
      
      - name: Commit and push ONLY if content changed
        run: |
          git config --local user.email "github-actions[bot]@users.noreply.github.com"
          git config --local user.name "github-actions[bot]"
          git add proxies.json
          
          # 🔍 Проверяем: изменился ли СПИСОК прокси (не просто timestamp)
          if ! git diff --staged --quiet -- proxies.json; then
            echo "✅ Changes detected in proxies.json"
            # [skip ci] предотвращает рекурсивный запуск воркфлоу
            git commit -m "chore: update proxies $(date +'%Y-%m-%d %H:%M') [skip ci]"
            git push
          else
            echo "ℹ️ No meaningful changes — skipping commit"
          fi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
