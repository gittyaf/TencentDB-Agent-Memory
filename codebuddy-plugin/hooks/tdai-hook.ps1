# TDAI Memory Hook for CodeBuddy IDE
# Cross-client memory sharing (matches Claude Code's session key hash)
param([string]$HookEvent = "unknown")

$LogFile = "C:\Users\randyyliu\CodeBuddy\20260526160648\tdai-hook-log.txt"
$GatewayUrl = "http://127.0.0.1:8421"
$StateFile = "$env:TEMP\tdai-hook-state.txt"

# Read stdin (hook input JSON)
$input_json = ""
if (-not [Console]::IsInputRedirected) {
    $input_json = "{}"
} else {
    $input_json = [Console]::In.ReadToEnd()
}

# Log
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $LogFile -Value "[TDAI-PS] $HookEvent hook triggered at $timestamp"

# Helper: derive project-scoped session key from cwd (matches Claude Code's getSessionKey)
function Get-SessionKey($cwd) {
    if (-not $cwd) {
        $cwd = if ($env:CODEBUDDY_PROJECT_DIR) { $env:CODEBUDDY_PROJECT_DIR } else { (Get-Location).Path }
    }
    $resolvedPath = [System.IO.Path]::GetFullPath($cwd)
    return ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($resolvedPath))).Replace('-','')).Substring(0,16).ToLower()
}

try {
    if ($HookEvent -eq "session-start") {
        Set-Content -Path $StateFile -Value "0"
        Write-Output "{}"
    }
    elseif ($HookEvent -eq "user-prompt-submit") {
        $data = $input_json | ConvertFrom-Json -ErrorAction SilentlyContinue
        $prompt = if ($data.prompt) { $data.prompt } else { "" }
        $session = Get-SessionKey $data.cwd

        # Cold start detection (full inject) vs warm (light)
        $turnCount = 0
        if (Test-Path $StateFile) {
            $turnCount = [int](Get-Content $StateFile -ErrorAction SilentlyContinue)
        }
        $isColdStart = ($turnCount -lt 1)
        Set-Content -Path $StateFile -Value ([string]($turnCount + 1))

        # Step 1: Recall (cold start only)
        $recallContext = ""
        if ($isColdStart) {
            $body = @{ query = $prompt; session_key = $session } | ConvertTo-Json -Compress
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $response = Invoke-RestMethod -Uri "$GatewayUrl/recall" -Method POST -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 4 -ErrorAction Stop
            if ($response.context) { $recallContext = $response.context }
        }

        # Step 2: L0 conversation search (always)
        $convContext = ""
        try {
            $searchBody = @{ query = $prompt; limit = 8 } | ConvertTo-Json -Compress
            $searchBytes = [System.Text.Encoding]::UTF8.GetBytes($searchBody)
            $searchResult = Invoke-RestMethod -Uri "$GatewayUrl/search/conversations" -Method POST -Body $searchBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 3 -ErrorAction Stop
            if ($searchResult.results) { $convContext = $searchResult.results }
        } catch {}

        # Step 3: Capture user message AFTER search (no self-pollution)
        if ($prompt) {
            $capBody = @{ user_content = $prompt; assistant_content = "(pending)"; session_key = $session } | ConvertTo-Json -Compress
            $capBytes = [System.Text.Encoding]::UTF8.GetBytes($capBody)
            try {
                Invoke-RestMethod -Uri "$GatewayUrl/capture" -Method POST -Body $capBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 2 -ErrorAction Stop | Out-Null
                Add-Content -Path $LogFile -Value "[TDAI-PS] Capture OK (session=$session)"
            } catch {
                Add-Content -Path $LogFile -Value "[TDAI-PS] Capture FAILED: $_"
            }
        }

        # Assemble output
        $fullContext = ""
        if ($recallContext) { $fullContext = $recallContext }
        if ($convContext) {
            $fullContext += "`n`n## Past conversations (relevant to current prompt)`n`n$convContext"
        }
        $searchGuide = @"

## Memory search (use Bash if above context is insufficient)
- L1 (facts): ``curl -s -X POST http://127.0.0.1:8421/search/memories -H "Content-Type: application/json" -d '{"query":"<keywords>","limit":5}'``
- L0 (raw messages): ``curl -s -X POST http://127.0.0.1:8421/search/conversations -H "Content-Type: application/json" -d '{"query":"<keywords>","limit":5}'``
- Tip: search with likely ANSWER words, not question words. Max 3 searches per question.
"@
        $fullContext += $searchGuide

        if ($fullContext) {
            $output = @{
                hookSpecificOutput = @{
                    hookEventName = "UserPromptSubmit"
                    additionalContext = $fullContext
                }
            } | ConvertTo-Json -Compress -Depth 5
            Write-Output $output
            $mode = if ($isColdStart) { "FULL" } else { "LIGHT" }
            Add-Content -Path $LogFile -Value "[TDAI-PS] Recall OK ($mode): $($fullContext.Length) chars"
        } else {
            Write-Output "{}"
        }
    }
    elseif ($HookEvent -eq "stop") {
        $data = $input_json | ConvertFrom-Json -ErrorAction SilentlyContinue
        $prompt = if ($data.prompt) { $data.prompt } else { "" }
        $session = Get-SessionKey $data.cwd

        # Read transcript_path to capture full user+assistant turn
        if ($data.transcript_path -and (Test-Path $data.transcript_path)) {
            try {
                $lines = Get-Content $data.transcript_path -ErrorAction Stop
                $lastUser = ""
                $lastAssistant = ""
                foreach ($line in $lines) {
                    $rec = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if (-not $rec) { continue }
                    if ($rec.type -eq "message" -and $rec.role -eq "user") {
                        $texts = @()
                        if ($rec.content -is [array]) {
                            foreach ($block in $rec.content) {
                                if (($block.type -eq "input_text" -or $block.type -eq "text") -and $block.text) {
                                    $texts += $block.text
                                }
                            }
                        }
                        if ($texts.Count -gt 0) { $lastUser = $texts -join " " }
                    }
                    elseif ($rec.type -eq "message" -and $rec.role -eq "assistant") {
                        $texts = @()
                        if ($rec.content -is [array]) {
                            foreach ($block in $rec.content) {
                                if (($block.type -eq "output_text" -or $block.type -eq "text") -and $block.text) {
                                    $texts += $block.text
                                }
                            }
                        }
                        if ($texts.Count -gt 0) { $lastAssistant = $texts -join " " }
                    }
                }
                if ($lastUser -and $lastAssistant) {
                    $truncUser = if ($lastUser.Length -gt 2000) { $lastUser.Substring(0, 2000) } else { $lastUser }
                    $truncAssist = if ($lastAssistant.Length -gt 2000) { $lastAssistant.Substring(0, 2000) } else { $lastAssistant }
                    $body = @{ user_content = $truncUser; assistant_content = $truncAssist; session_key = $session } | ConvertTo-Json -Compress
                    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                    Invoke-RestMethod -Uri "$GatewayUrl/capture" -Method POST -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 4 -ErrorAction SilentlyContinue | Out-Null
                    Add-Content -Path $LogFile -Value "[TDAI-PS] Capture (full turn) session=$session"
                }
            } catch {
                Add-Content -Path $LogFile -Value "[TDAI-PS] Transcript read failed: $_"
            }
        }
        elseif ($prompt) {
            $body = @{ user_content = $prompt; assistant_content = ""; session_key = $session } | ConvertTo-Json -Compress
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            Invoke-RestMethod -Uri "$GatewayUrl/capture" -Method POST -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 4 -ErrorAction SilentlyContinue | Out-Null
        }
        Write-Output "{}"
    }
    else {
        Write-Output "{}"
    }
}
catch {
    Add-Content -Path $LogFile -Value "[TDAI-PS] ERROR: $_"
    Write-Output "{}"
}
