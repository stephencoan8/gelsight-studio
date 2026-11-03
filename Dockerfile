FROM node:22-bookworm-slim AS ui
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* frontend/
RUN cd frontend && npm install
COPY frontend frontend
RUN cd frontend && npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY gelsight gelsight
COPY studio studio
COPY backend backend
COPY reference reference
COPY pyproject.toml .
COPY --from=ui /src/frontend/dist frontend/dist
ENV STUDIO_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
