# Runbook: Rollback

## Revert to Previous Revision

```bash
# List revisions (most recent first)
az containerapp revision list -n sb-server -g sb-prod-rg -o table

# Activate the previous revision (replace <prev-revision> with name from list)
az containerapp revision activate -n sb-server -g sb-prod-rg \
  --revision <prev-revision>

# Deactivate the broken revision
az containerapp revision deactivate -n sb-server -g sb-prod-rg \
  --revision <broken-revision>

# Verify health
curl https://singing.rcnx.io/healthz
```

## Migration Compatibility

If a sprint ships a DB migration (new `migrations/00XX_*.sql`), rolling
back to a previous revision leaves the migration applied. Ensure the
previous binary can tolerate the migrated schema (additive-only
migrations are safe; destructive changes need a forward-only fix).

If the migration is not backward-compatible, the rollback path is to
restore from the most recent Azure Files snapshot — documented in the
Azure portal under the storage account file share.
