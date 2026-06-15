# Deploy incident-stream-processor to Azure Container Apps from local machine
# Run from: C:\SolEng\POC\incident-stream-processor
#
# Example (minimal - auto-resolves agent URL/key and checkpoint storage):
#   .\deploy-local.ps1 `
#     -MongoUri "mongodb+srv://..." `
#     -DtEnvUrl "https://your-env.apps.dynatrace.com" `
#     -DtClientId "dt0s02...." `
#     -DtClientSecret "dt0s02...."
#
# Example (explicit agent + function key):
#   .\deploy-local.ps1 `
#     -MongoUri "mongodb+srv://..." `
#     -FunctionAppUrl "https://incident-remediation-agent-fn.azurewebsites.net/api/processIncident" `
#     -FunctionAppKey "..." `
#     -CheckpointStorageConnectionString "DefaultEndpointsProtocol=https;..."

param(
    [string]$ResourceGroup = "rg-freight-planning",
    [string]$Location = "eastus",
    [string]$ContainerAppName = "incident-stream-proc",
    [string]$ContainerAppsEnvironment = "cae-freight-planning",
    [string]$AcrName = "acrfreightplanning",
    [string]$ImageTag = "latest",
    [int]$TargetPort = 3000,

    [string]$FunctionAppName = "incident-remediation-agent-fn",
    [string]$StorageAccountName = "stincidentremediation",

    [Parameter(Mandatory = $true)]
    [string]$MongoUri,

    [string]$MongoDbName = "incident_management",
    [string]$MongoCollection = "service_error_logs",

    [string]$FunctionAppUrl = "",
    [string]$FunctionAppKey = "",

    [string]$DtEnvUrl = "",
    [string]$DtClientId = "",
    [string]$DtClientSecret = "",

    [string]$CheckpointStorageConnectionString = "",
    [string]$CheckpointContainer = "dynatrace-poller-checkpoints",
    [string]$CheckpointBlob = "checkpoint.json",

    [string]$DynatraceWebhookToken = "",
    [string]$LogLevel = "info",

    [string]$PollerServiceNames = "freight-planning-admin-service,freight-planning-transaction-service,freight-planning-invoice-service",

    [switch]$SkipBuild,
    [switch]$SkipInfrastructure
)

$ErrorActionPreference = "Stop"

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-AzResourceExists {
    param([scriptblock]$AzCommand)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $AzCommand 2>$null | Out-Null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    return $ok
}

function Get-ContainerAppEnvArgs {
    param(
        [hashtable]$Env
    )
    $args = @()
    foreach ($key in ($Env.Keys | Sort-Object)) {
        $value = $Env[$key]
        if ($null -ne $value -and $value -ne "") {
            $args += "${key}=$value"
        }
    }
    return $args
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "Container App Deployment - incident-stream-processor" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# Step 0: Verify tools and Azure login
Write-Host "Step 0: Verifying prerequisites..." -ForegroundColor Yellow

if (-not (Test-CommandExists "az")) {
    Write-Host "ERROR: 'az' is not installed or not on PATH." -ForegroundColor Red
    exit 1
}

$currentSub = az account show --query "{Name:name, ID:id, State:state}" -o json 2>$null | ConvertFrom-Json
if (-not $currentSub) {
    Write-Host "ERROR: Not logged in to Azure. Run 'az login' first." -ForegroundColor Red
    exit 1
}

Write-Host "Current subscription:" -ForegroundColor White
Write-Host "  Name:  $($currentSub.Name)" -ForegroundColor White
Write-Host "  ID:    $($currentSub.ID)" -ForegroundColor White
Write-Host "  State: $($currentSub.State)" -ForegroundColor White
Write-Host ""

if ($currentSub.State -ne "Enabled") {
    Write-Host "ERROR: Current subscription is not enabled." -ForegroundColor Red
    exit 1
}

# Resolve agent endpoint and key if omitted
if (-not $FunctionAppUrl) {
    Write-Host "Resolving FUNCTION_APP_URL from $FunctionAppName..." -ForegroundColor Yellow
    $functionHost = az functionapp show `
        --name $FunctionAppName `
        --resource-group $ResourceGroup `
        --query "defaultHostName" -o tsv
    if (-not $functionHost) {
        Write-Host "ERROR: Could not resolve Function App host. Pass -FunctionAppUrl explicitly." -ForegroundColor Red
        exit 1
    }
    $FunctionAppUrl = "https://$functionHost/api/processIncident"
}

if (-not $FunctionAppKey) {
    Write-Host "Resolving FUNCTION_APP_KEY from $FunctionAppName..." -ForegroundColor Yellow
    $FunctionAppKey = az functionapp keys list `
        --name $FunctionAppName `
        --resource-group $ResourceGroup `
        --query "functionKeys.default" -o tsv
    if (-not $FunctionAppKey) {
        Write-Host "ERROR: Could not resolve function key. Pass -FunctionAppKey explicitly." -ForegroundColor Red
        exit 1
    }
}

if (-not $CheckpointStorageConnectionString) {
    Write-Host "Resolving CHECKPOINT_STORAGE_CONNECTION_STRING from $StorageAccountName..." -ForegroundColor Yellow
    $CheckpointStorageConnectionString = az storage account show-connection-string `
        --name $StorageAccountName `
        --resource-group $ResourceGroup `
        --query "connectionString" -o tsv
    if (-not $CheckpointStorageConnectionString) {
        Write-Host "ERROR: Could not resolve storage connection string. Pass -CheckpointStorageConnectionString explicitly." -ForegroundColor Red
        exit 1
    }
}

if (-not $DtEnvUrl -or -not $DtClientId -or -not $DtClientSecret) {
    Write-Host "WARNING: Dynatrace poller vars not fully set (DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET)." -ForegroundColor Yellow
    Write-Host "         Grail log polling will be disabled; change stream + webhooks still work." -ForegroundColor Yellow
    Write-Host ""
}

$envVars = @{
    MONGO_URI                              = $MongoUri
    MONGO_DB_NAME                          = $MongoDbName
    MONGO_COLLECTION                       = $MongoCollection
    FUNCTION_APP_URL                       = $FunctionAppUrl
    FUNCTION_APP_KEY                       = $FunctionAppKey
    CHECKPOINT_STORAGE_CONNECTION_STRING   = $CheckpointStorageConnectionString
    CHECKPOINT_CONTAINER                   = $CheckpointContainer
    CHECKPOINT_BLOB                        = $CheckpointBlob
    LOG_LEVEL                              = $LogLevel
    PORT                                   = [string]$TargetPort
}

if ($DtEnvUrl)            { $envVars.DT_ENV_URL = $DtEnvUrl }
if ($DtClientId)          { $envVars.DT_CLIENT_ID = $DtClientId }
if ($DtClientSecret)      { $envVars.DT_CLIENT_SECRET = $DtClientSecret }
if ($DynatraceWebhookToken) { $envVars.DYNATRACE_WEBHOOK_TOKEN = $DynatraceWebhookToken }
if ($PollerServiceNames)  { $envVars.POLLER_SERVICE_NAMES = $PollerServiceNames }

$envArgs = Get-ContainerAppEnvArgs -Env $envVars

if (-not $SkipInfrastructure) {
    # Step 1: Resource group
    Write-Host "Step 1: Checking resource group..." -ForegroundColor Yellow
    $rgExists = az group exists --name $ResourceGroup
    if ($rgExists -eq "false") {
        Write-Host "Creating resource group: $ResourceGroup" -ForegroundColor Yellow
        az group create --name $ResourceGroup --location $Location | Out-Null
    } else {
        Write-Host "Resource group exists: $ResourceGroup" -ForegroundColor Green
    }
    Write-Host ""

    # Step 2: ACR
    Write-Host "Step 2: Checking Azure Container Registry..." -ForegroundColor Yellow
    $acrExists = Test-AzResourceExists {
        az acr show --name $AcrName --resource-group $ResourceGroup
    }
    if (-not $acrExists) {
        Write-Host "ERROR: ACR '$AcrName' not found in $ResourceGroup." -ForegroundColor Red
        Write-Host "Create it first or pass -AcrName with an existing registry." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "ACR exists: $AcrName" -ForegroundColor Green
    Write-Host ""

    # Step 3: Container Apps environment
    Write-Host "Step 3: Checking Container Apps environment..." -ForegroundColor Yellow
    $caeExists = Test-AzResourceExists {
        az containerapp env show --name $ContainerAppsEnvironment --resource-group $ResourceGroup
    }
    if (-not $caeExists) {
        Write-Host "ERROR: Container Apps environment '$ContainerAppsEnvironment' not found in $ResourceGroup." -ForegroundColor Red
        Write-Host "Create it first or pass -ContainerAppsEnvironment with an existing environment." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Container Apps environment exists: $ContainerAppsEnvironment" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "Step 1-3: Skipping infrastructure checks (-SkipInfrastructure)" -ForegroundColor Yellow
    Write-Host ""
}

$AcrServer = "$AcrName.azurecr.io"
$Image = "${ContainerAppName}:${ImageTag}"
$FullImage = "$AcrServer/$Image"

# Step 4: Build and push image
if (-not $SkipBuild) {
    Write-Host "Step 4: Building and pushing Docker image to ACR..." -ForegroundColor Yellow
    Write-Host "  Registry: $AcrName" -ForegroundColor Gray
    Write-Host "  Image:    $Image" -ForegroundColor Gray
    az acr build `
        --registry $AcrName `
        --image $Image `
        .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: ACR build failed" -ForegroundColor Red
        exit 1
    }
    Write-Host ""
} else {
    Write-Host "Step 4: Skipping image build (-SkipBuild)" -ForegroundColor Yellow
    Write-Host ""
}

# Step 5: ACR credentials
Write-Host "Step 5: Fetching ACR credentials..." -ForegroundColor Yellow
$AcrUsername = az acr credential show --name $AcrName --query "username" -o tsv
$AcrPassword = az acr credential show --name $AcrName --query "passwords[0].value" -o tsv
if (-not $AcrUsername -or -not $AcrPassword) {
    Write-Host "ERROR: Could not read ACR admin credentials. Enable admin on ACR or use managed identity." -ForegroundColor Red
    exit 1
}
Write-Host ""

# Step 6: Create or update Container App
Write-Host "Step 6: Deploying Container App..." -ForegroundColor Yellow
$appExists = Test-AzResourceExists {
    az containerapp show --name $ContainerAppName --resource-group $ResourceGroup
}

if (-not $appExists) {
    Write-Host "Creating Container App: $ContainerAppName" -ForegroundColor Yellow
    az containerapp create `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --environment $ContainerAppsEnvironment `
        --image $FullImage `
        --min-replicas 1 `
        --max-replicas 1 `
        --ingress external `
        --target-port $TargetPort `
        --registry-server $AcrServer `
        --registry-username $AcrUsername `
        --registry-password $AcrPassword `
        --env-vars @envArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Container App creation failed" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Updating Container App: $ContainerAppName" -ForegroundColor Yellow
    az containerapp update `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --image $FullImage `
        --min-replicas 1 `
        --max-replicas 1 `
        --set-env-vars @envArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Container App update failed" -ForegroundColor Red
        exit 1
    }

    az containerapp ingress enable `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --type external `
        --target-port $TargetPort | Out-Null

    az containerapp registry set `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --server $AcrServer `
        --username $AcrUsername `
        --password $AcrPassword | Out-Null
}

Write-Host "Container App deployed" -ForegroundColor Green
Write-Host ""

# Step 6b: Start app if it was stopped in Azure (Stop action sets runningStatus=Stopped)
$runningStatus = az containerapp show `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "properties.runningStatus" -o tsv 2>$null

if ($runningStatus -eq "Stopped") {
    Write-Host "Container App is stopped - starting it..." -ForegroundColor Yellow
    $appId = az containerapp show `
        --name $ContainerAppName `
        --resource-group $ResourceGroup `
        --query "id" -o tsv
    az resource invoke-action --action start --ids $appId | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Container App started" -ForegroundColor Green
    } else {
        Write-Host "WARNING: Could not start Container App automatically. Start it in Azure Portal." -ForegroundColor Yellow
    }
}

Write-Host ""

# Step 7: Summary
Write-Host "====================================================" -ForegroundColor Green
Write-Host "DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'

$fqdn = az containerapp show `
    --name $ContainerAppName `
    --resource-group $ResourceGroup `
    --query "properties.configuration.ingress.fqdn" -o tsv 2>$null

$ErrorActionPreference = $prevEap

if ($fqdn) {
    $healthUrl = "https://$fqdn/health"
    $webhookUrl = "https://$fqdn/api/dynatrace/webhook"
    Write-Host "Container App URL: https://$fqdn" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Health check:" -ForegroundColor Cyan
    Write-Host "  $healthUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "Dynatrace webhook (optional):" -ForegroundColor Cyan
    Write-Host "  $webhookUrl" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "Container App: $ContainerAppName (ingress FQDN not available yet)" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "Configured endpoints:" -ForegroundColor Cyan
Write-Host "  FUNCTION_APP_URL=$FunctionAppUrl" -ForegroundColor White
Write-Host "  MONGO_DB_NAME=$MongoDbName" -ForegroundColor White
Write-Host "  MONGO_COLLECTION=$MongoCollection" -ForegroundColor White
Write-Host "  CHECKPOINT_CONTAINER=$CheckpointContainer" -ForegroundColor White
Write-Host ""

Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Verify health:" -ForegroundColor White
if ($fqdn) {
    Write-Host "   Invoke-RestMethod -Uri '$healthUrl'" -ForegroundColor Gray
}
Write-Host "2. Stream logs:" -ForegroundColor White
Write-Host "   az containerapp logs show --name $ContainerAppName --resource-group $ResourceGroup --follow" -ForegroundColor Gray
Write-Host "3. Confirm change stream + Dynatrace poller started in logs" -ForegroundColor White
Write-Host ""
