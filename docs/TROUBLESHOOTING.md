# Troubleshooting

## The backend does not start

Check:

- `MASTER_KEY` exists and has 64 hex characters
- the data directory is writable
- the control database file path is correct

## SQLite discovery finds nothing

Check:

- `SQLITE_DISCOVERY_PATH` points to a mounted directory
- the directory contains files ending in `.db`
- the configured project ID exists

## Imported databases are not updated

Remember:

- import copies the `.db` file into managed storage
- changes should be made through queries or migrations against the managed copy

## libsql connection fails

Check:

- URL is correct
- token is valid
- remote server is reachable from your deployment environment

## Coolify deployment fails

Check:

- the Dockerfile path is correct
- the exposed port is `3000`
- `/app/data` is mounted as persistent storage
- `MASTER_KEY` is set
