#!/bin/bash
# deploy.sh — builds and deploys incident-stream-processor to Azure Container Instance
# Run once to set up. Re-run to update the container image.

set -e

# ── Config — change these ─────────────────────────────────────────────────────
RESOURCE_GROUP="rg-freight-planning"
LOCATION="eastus"
ACR_NAME="incidentagentacr"          # must be globally unique, lowercase, no hyphens
CONTAINER_NAME="incident-stream-processor"
IMAGE_NAME="incident-stream-processor"
IMAGE_TAG="latest"
# ─────────────────────────────────────────────────────────────────────────────

echo "==> Creating resource group"
az group create --name $RESOURCE_GROUP --location $LOCATION

echo "==> Creating Azure Container Registry"
az acr create \
  --resource-group $RESOURCE_GROUP \
  --name $ACR_NAME \
  --sku Basic \
  --admin-enabled true

echo "==> Building and pushing image to ACR"
az acr build \
  --registry $ACR_NAME \
  --image $IMAGE_NAME:$IMAGE_TAG \
  .

echo "==> Getting ACR credentials"
ACR_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)
ACR_USERNAME=$(az acr credential show --name $ACR_NAME --query username -o tsv)
ACR_PASSWORD=$(az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv)

echo "==> Deploying to Azure Container Instance"
az container create \
  --resource-group $RESOURCE_GROUP \
  --name $CONTAINER_NAME \
  --image "$ACR_SERVER/$IMAGE_NAME:$IMAGE_TAG" \
  --registry-login-server $ACR_SERVER \
  --registry-username $ACR_USERNAME \
  --registry-password $ACR_PASSWORD \
  --cpu 1 \
  --memory 1 \
  --restart-policy Always \
  --environment-variables \
    MONGO_DB_NAME=$MONGO_DB_NAME \
    MONGO_COLLECTION=$MONGO_COLLECTION \
    LOG_LEVEL=info \
  --secure-environment-variables \
    MONGO_URI=$MONGO_URI \
    FUNCTION_APP_URL=$FUNCTION_APP_URL \
    FUNCTION_APP_KEY=$FUNCTION_APP_KEY

echo ""
echo "==> Done! Container is running."
echo "==> View logs with:"
echo "    az container logs --resource-group $RESOURCE_GROUP --name $CONTAINER_NAME --follow"
