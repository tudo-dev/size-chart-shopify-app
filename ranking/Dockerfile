# Tudoholic Ranking: one static Go binary on an empty image (~8 MB total).
FROM public.ecr.aws/docker/library/golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /ranking .

FROM scratch
# HTTPS to Shopify needs the certificate authorities; nothing else is in the image.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /ranking /ranking
EXPOSE 8080
ENTRYPOINT ["/ranking"]
