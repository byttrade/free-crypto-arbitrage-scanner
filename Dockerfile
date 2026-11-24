FROM node:22-alpine AS web
WORKDIR /web
COPY package.json ./
RUN npm install
COPY web ./web
RUN npm run build:web

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH \
    HOST=0.0.0.0 PORT=8780 DATA_DIR=/data
RUN useradd --system --uid 10001 terminal \
 && mkdir -p /data /opt/venv /src && chown terminal /data /opt/venv /src
# Панель ставится пакетом в venv непривилегированного пользователя: так работает самообновление
# (bytx и сама панель с PyPI), как в free-crypto-trading-bot.
USER terminal
RUN python -m venv /opt/venv
COPY --chown=terminal pyproject.toml README.md LICENSE /src/
COPY --chown=terminal arbdesk /src/arbdesk
COPY --chown=terminal --from=web /web/arbdesk/web /src/arbdesk/web
RUN pip install --no-cache-dir /src && rm -rf /src/build
WORKDIR /data
VOLUME /data
EXPOSE 8780
CMD ["arbdesk"]
