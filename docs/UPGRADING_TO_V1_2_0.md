# Upgrading to zeos v1.2.0

v1.2.0 relocates all operator-mutated state out of the zeos repo and into a
machine-global state root, `~/.zeos`, mirroring the `~/.claude` and `~/.codex`
convention. The repo becomes pure product: the public mirror is byte-identical
to any operator's mirror.

## What moved

| Was (in the repo)                       | Now (state root)                          |
|-----------------------------------------|-------------------------------------------|
| `~/projects/zeos/apps/REGISTRY.json`    | `~/.zeos/apps/REGISTRY.json`              |
| `~/projects/zeos/profiles/<operator>/`  | `~/.zeos/profiles/<operator>/`            |
| `~/projects/zeos/souls/<app_id>/`       | `~/.zeos/souls/<app_id>/`                 |
| `~/projects/zeos/memory/<app_id>/`      | `~/.zeos/memory/<app_id>/`                |
| `~/projects/zeos/journals/<app_id>/`    | `~/.zeos/journals/<app_id>/`              |
| (new in v1.2.0)                         | `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md` |

`profiles/template/` stays in the repo (it is a product default). The project
`CLAUDE.md` stays in each project repo (operator decides commit policy).

Both roots honor an environment override: `ZEOS_REPO_ROOT` (default
`~/projects/zeos`) and `ZEOS_STATE_ROOT` (default `~/.zeos`).

## The safe update path

### If you are already on v1.2.0 or later

Re-run the installer. It snapshots your state before pulling, then relocates
and verifies it automatically:

```bash
bash ~/projects/zeos/tools/install.sh --update
```

### If you are upgrading from v1.1.0 or earlier (first jump)

The migration tool does not exist in your current checkout yet, so the
installer cannot snapshot your registry before the pull. Do a one-time manual
backup first, then pull, then migrate:

```bash
# 1. Back up your current operator state BEFORE pulling.
ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p "$HOME/.zeos/backups/$ts/repo-local-state/apps"
cp ~/projects/zeos/apps/REGISTRY.json "$HOME/.zeos/backups/$ts/repo-local-state/apps/" 2>/dev/null || true
for d in souls memory journals; do
  [ -d ~/projects/zeos/$d ] && cp -R ~/projects/zeos/$d "$HOME/.zeos/backups/$ts/repo-local-state/"
done
for p in ~/projects/zeos/profiles/*/; do
  case "$(basename "$p")" in template) continue ;; esac
  mkdir -p "$HOME/.zeos/backups/$ts/repo-local-state/profiles"
  cp -R "$p" "$HOME/.zeos/backups/$ts/repo-local-state/profiles/"
done

# 2. Pull v1.2.0. If git reports a conflict on apps/REGISTRY.json (because you
#    committed local registry entries), keep your version; your data is already
#    backed up in step 1.
cd ~/projects/zeos && git pull origin main

# 3. Relocate state into ~/.zeos, ingesting the registry from the backup.
python3 ~/projects/zeos/tools/migrate-state.py --apply --cleanup-repo-state \
  --registry-source "$HOME/.zeos/backups/$ts/repo-local-state/apps/REGISTRY.json"
```

### Verify

```bash
cat ~/.zeos/.zeos-state-version          # 1.2.0
python3 -m json.tool < ~/.zeos/apps/REGISTRY.json > /dev/null && echo "registry OK"
ls ~/.zeos/souls ~/.zeos/journals ~/.zeos/memory
```

Then restart Claude Code so the inject MCP server picks up the new path
resolution, and boot a project: `/project <id>`.

## Rollback

Your pre-migration state is preserved under
`~/.zeos/backups/<timestamp>/repo-local-state/` with the original tree shape.
The migration is copy-then-verify; it removes the in-repo originals only after
a SHA-256 match. If anything looks wrong, your data is in the backup.

## Notes

- The registry is no longer committed to the repo. `/newproject` writes it to
  `~/.zeos/apps/REGISTRY.json`. The `--no-commit` flag is still accepted but is
  a no-op.
- `tools/uninstall.sh` no longer removes operator state by default. Pass
  `--purge-state` to delete `~/.zeos` as well.
