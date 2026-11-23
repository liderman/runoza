# Release checklist

Verify the source, release archives, container images, and desktop builds independently. Run the relevant checks on each supported platform.

- Build from a clean checkout. Run `npm run check` and integration tests in a disposable environment. Record any skipped scenarios.
- Verify that the release includes standalone `compose.yaml` and `env.example`, the Compose file pins the released image digest, and both files are covered by `SHA256SUMS.txt`.
- Verify a fresh Compose deployment and an upgrade from the previous supported schema. Test restoring PostgreSQL, object storage, and workspace backups where applicable.
- Check user and project permissions, shared-terminal user routing, separate conversation folders, PTY, cancellation, container recreation with preserved files, and job queue processing. Check isolation separately when releasing the optional pool backend.
- Verify signed desktop builds on each advertised platform and document release limitations.
- Generate an SBOM and license notices. Verify image digests and triage applicable findings using the [security process](security/README.md).
- Review the Git index and reachable history for private attachments, local paths, and secrets. Use synthetic data in screenshots and examples.
