# Deployment Checklist

Before deploying to Coolify:

1. Set `MASTER_KEY` to a 64-hex production secret.
2. Set `DATABASE_FILE` to persistent storage.
3. Set `SQLITE_STORAGE_ROOT` to persistent storage.
4. Set `CORS_ORIGIN` to the exact frontend origin.
5. Set `NEXT_PUBLIC_API_URL` to the backend URL.
6. Verify `npm test` passes in `backend/`.
7. Verify `npm run smoke` passes in `backend/`.
8. Verify `npm run build` passes in `frontend/`.
9. Confirm volume mounts survive container restart.
10. Confirm the first admin account is created and can log in.
11. Confirm project creation, database creation and query flow work end to end.
12. Confirm logout clears cookies and requires re-authentication.
