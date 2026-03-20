FROM opencut-local-transcribe-base:latest

WORKDIR /app

COPY app.py /app/app.py
COPY transcribe.py /app/transcribe.py
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8765

CMD ["/app/docker-entrypoint.sh"]
