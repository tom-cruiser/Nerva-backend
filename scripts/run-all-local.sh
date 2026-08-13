#!/bin/bash

# ============================================
#   Nerva Microservices - Development Runner
# ============================================

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SERVICES=(
    "auth-tenant:3001"
    "inventory:3002"
    "sales-sync:3003"
    "ledger-payments:3004"
    "whatsapp-engine:3005"
    "shifts:3006"
    "superadmin:3007"
    "realtime:3008"
)
GATEWAY_PORT=8080
REDIS_PORT=6379
REDIS_CONTAINER="redis-nerva"

# Logs directory
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

# ============================================
# Helper Functions
# ============================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}   $1${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
}

# ============================================
# Port Management
# ============================================

check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0 # Port is in use
    else
        return 1 # Port is free
    fi
}

kill_port() {
    local port=$1
    local pids=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null
        log_warning "Killed processes on port $port"
    fi
}

# ============================================
# Docker Management
# ============================================

check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        return 1
    fi
    if ! docker ps &> /dev/null; then
        log_error "Docker is not running. Please start Docker first."
        return 1
    fi
    return 0
}

# ============================================
# Redis Management (Docker only)
# ============================================

check_redis() {
    # Check if Redis container is running and responding
    if docker ps --filter "name=$REDIS_CONTAINER" --format "{{.Names}}" | grep -q "$REDIS_CONTAINER"; then
        if docker exec $REDIS_CONTAINER redis-cli ping 2>/dev/null | grep -q "PONG"; then
            return 0 # Redis is running
        fi
    fi
    return 1 # Redis is not running
}

start_redis() {
    log_info "Checking Redis..."
    
    # Check if Redis is already running
    if check_redis; then
        log_success "Redis is already running on port $REDIS_PORT"
        return 0
    fi
    
    # Check if Docker is available
    if ! check_docker; then
        log_error "Docker is required to run Redis"
        return 1
    fi
    
    # Check if port 6379 is in use by something else
    if check_port $REDIS_PORT; then
        log_warning "Port $REDIS_PORT is in use by another process."
        log_info "Attempting to free port $REDIS_PORT..."
        kill_port $REDIS_PORT
        sleep 2
    fi
    
    # Check if container exists but is stopped
    if docker ps -a --filter "name=$REDIS_CONTAINER" --format "{{.Names}}" | grep -q "$REDIS_CONTAINER"; then
        log_info "Starting existing Redis container..."
        docker start $REDIS_CONTAINER 2>/dev/null
    else
        log_info "Creating and starting Redis container..."
        docker run -d \
            --name $REDIS_CONTAINER \
            -p $REDIS_PORT:$REDIS_PORT \
            --restart unless-stopped \
            redis:7-alpine \
            redis-server --save 60 1 --loglevel warning
    fi
    
    # Wait for Redis to be ready
    log_info "Waiting for Redis to be ready..."
    local max_attempts=15
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        sleep 1
        if docker exec $REDIS_CONTAINER redis-cli ping 2>/dev/null | grep -q "PONG"; then
            log_success "Redis started successfully on port $REDIS_PORT"
            return 0
        fi
        ((attempt++))
        echo -n "."
    done
    echo ""
    
    log_error "Redis failed to start. Check logs: docker logs $REDIS_CONTAINER"
    docker logs $REDIS_CONTAINER --tail 20
    return 1
}

# ============================================
# Service Management
# ============================================

start_service() {
    local service=$1
    local port=$2
    
    log_info "Starting $service on port $port..."
    
    # Kill any process using this port
    if check_port $port; then
        kill_port $port
        sleep 1
    fi
    
    # Start the service in the background
    PORT=$port DOTENV_CONFIG_PATH="$PWD/.env" npm run dev --workspace=services/$service > "$LOG_DIR/${service}.log" 2>&1 &
    local pid=$!
    
    # Wait for the port to be listening
    local max_attempts=30
    local attempt=0
    while ! check_port $port && [ $attempt -lt $max_attempts ]; do
        sleep 1
        ((attempt++))
        if [ $((attempt % 5)) -eq 0 ]; then
            echo -n "."
        fi
    done
    echo ""
    
    if check_port $port; then
        log_success "$service started on port $port (PID: $pid)"
        return 0
    else
        log_error "$service failed to start on port $port"
        log_info "Check logs: tail -f $LOG_DIR/${service}.log"
        # Show last few lines of the log
        tail -5 "$LOG_DIR/${service}.log" 2>/dev/null || true
        return 1
    fi
}

start_gateway() {
    log_info "Starting Dev Gateway on port $GATEWAY_PORT..."
    
    # Kill any process using the gateway port
    if check_port $GATEWAY_PORT; then
        kill_port $GATEWAY_PORT
        sleep 1
    fi
    
    # Start the gateway
    GATEWAY_PORT=$GATEWAY_PORT node scripts/dev-gateway.js > "$LOG_DIR/gateway.log" 2>&1 &
    local pid=$!
    
    # Wait for the gateway to be ready
    sleep 3
    if check_port $GATEWAY_PORT; then
        log_success "Gateway started on port $GATEWAY_PORT (PID: $pid)"
        return 0
    else
        log_error "Gateway failed to start on port $GATEWAY_PORT"
        log_info "Check logs: tail -f $LOG_DIR/gateway.log"
        tail -5 "$LOG_DIR/gateway.log" 2>/dev/null || true
        return 1
    fi
}

# ============================================
# Cleanup
# ============================================

cleanup() {
    log_section "Shutting Down Services"
    log_info "Stopping all services..."
    
    # Kill all node processes started by this script
    pkill -f "ts-node-dev" 2>/dev/null
    pkill -f "dev-gateway" 2>/dev/null
    
    log_success "All services stopped"
    exit 0
}

# ============================================
# Main Execution
# ============================================

main() {
    log_section "Nerva Microservices - Development Runner"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --no-redis)
                NO_REDIS="true"
                shift
                ;;
            --help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --no-redis       Skip Redis startup (use existing)"
                echo "  --help           Show this help message"
                echo ""
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Use --help for usage"
                exit 1
                ;;
        esac
        shift
    done
    
    # Trap Ctrl+C
    trap cleanup INT TERM
    
    # ============================================
    # Start Infrastructure
    # ============================================
    
    # Start Redis
    if [[ "$NO_REDIS" != "true" ]]; then
        if ! start_redis; then
            log_error "Redis is required. Exiting."
            exit 1
        fi
    else
        log_warning "Skipping Redis startup (--no-redis flag)"
        if ! check_redis; then
            log_error "Redis is not running. Please start Redis first."
            log_info "Try: docker start $REDIS_CONTAINER"
            exit 1
        fi
        log_success "Redis is running"
    fi
    
    # ============================================
    # Start Microservices
    # ============================================
    
    log_section "Starting Microservices"
    
    local failed_services=()
    local success_count=0
    
    for service_info in "${SERVICES[@]}"; do
        IFS=':' read -r service port <<< "$service_info"
        if start_service "$service" "$port"; then
            ((success_count++))
        else
            failed_services+=("$service")
        fi
        echo ""
    done
    
    # ============================================
    # Start Gateway
    # ============================================
    
    log_section "Starting Gateway"
    
    if start_gateway; then
        ((success_count++))
    else
        failed_services+=("gateway")
    fi
    
    # ============================================
    # Summary
    # ============================================
    
    log_section "Summary"
    
    echo -e "${GREEN}✅ $success_count services started successfully${NC}"
    
    if [ ${#failed_services[@]} -ne 0 ]; then
        echo -e "${RED}❌ Failed services:${NC}"
        for service in "${failed_services[@]}"; do
            echo -e "  ${RED}- $service${NC}"
        done
        echo ""
        echo -e "${YELLOW}Check logs in $LOG_DIR/ for details${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}Services running on:${NC}"
    echo "  🏠 Gateway:    http://localhost:$GATEWAY_PORT"
    echo ""
    echo -e "${BLUE}Service endpoints:${NC}"
    echo "  🔐 Auth:       http://localhost:$GATEWAY_PORT/api/v1/auth/"
    echo "  📦 Inventory:  http://localhost:$GATEWAY_PORT/api/v1/inventory/"
    echo "  📊 Sales:      http://localhost:$GATEWAY_PORT/api/v1/sales/"
    echo "  📒 Ledger:     http://localhost:$GATEWAY_PORT/api/v1/ledger/"
    echo "  💬 WhatsApp:   http://localhost:$GATEWAY_PORT/api/v1/whatsapp/"
    echo "  🕒 Shifts:     http://localhost:$GATEWAY_PORT/api/v1/shifts/"
    echo "  🛡️  Superadmin: http://localhost:$GATEWAY_PORT/api/v1/superadmin/  (requires superadmin:access — see services/superadmin/scripts/grant-superadmin.ts)"
    echo "  📡 Realtime:   ws://localhost:$GATEWAY_PORT/socket.io/  (WebSocket push + daily expiration cron, no REST API)"
    echo ""
    echo -e "${BLUE}Direct service ports (for debugging):${NC}"
    for service_info in "${SERVICES[@]}"; do
        IFS=':' read -r service port <<< "$service_info"
        echo "  $service: http://localhost:$port"
    done
    echo ""
    echo -e "${YELLOW}Logs:${NC}"
    echo "  tail -f $LOG_DIR/*.log"
    echo "  tail -f $LOG_DIR/auth.log    # specific service"
    echo ""
    echo -e "${CYAN}Testing:${NC}"
    echo "  curl http://localhost:$GATEWAY_PORT/health"
    echo ""
    echo -e "${RED}Press Ctrl+C to stop all services${NC}"
    
    # Wait for all background processes
    wait
}

# ============================================
# Run the main function
# ============================================

main "$@"