# Release checklist

Verify the source, release archives, container images, and desktop builds independently. Run the relevant checks on each supported platform.

- Build from a clean checkout. Run `npm run check` and integration tests in a disposable environment. Record any skipped scenarios.
- Verify a fresh Compose deployment and an upgrade from the previous supported schema. Test restoring PostgreSQL, object storage, and workspace backups where applicable.
- Check user and project permissions, workspace isolation, PTY, cancellation, recovery, and job queue processing.
- Verify signed desktop builds on each advertised platform and document release limitations.
- Generate an SBOM and license notices. Verify image digests and triage applicable findings using the [security process](security/README.md).
- Review the Git index and reachable history for private attachments, local paths, and secrets. Use synthetic data in screenshots and examples.
