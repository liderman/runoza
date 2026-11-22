FROM python:3.12.16-slim AS builder
RUN pip install --no-cache-dir 'litellm[proxy]==1.108.5'
RUN pip uninstall -y litellm-enterprise
FROM python:3.12.16-slim
COPY --from=builder /usr/local /usr/local
USER 65532:65532
ENTRYPOINT ["litellm"]
CMD ["--config", "/config/config.yaml", "--host", "0.0.0.0", "--port", "4000"]
