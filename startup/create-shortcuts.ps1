$root    = 'C:\Users\Admin\ai-development\ai-development'
$desktop = [Environment]::GetFolderPath('Desktop')
$wsh     = New-Object -ComObject WScript.Shell
$icons   = "$root\startup\icons"

# Remove stale blank shortcut if present
$blank = Join-Path $desktop '.lnk'
if (Test-Path $blank) { Remove-Item $blank -Force }

$shortcuts = @(
    [pscustomobject]@{ Name='ATS';         Bat='start.bat';     Inst='';           Icon="$icons\launcher.ico,0"        },
    [pscustomobject]@{ Name='Start All';   Bat='start-all.bat'; Inst='';           Icon="$icons\start_all.ico,0"       },
    [pscustomobject]@{ Name='API Server';  Bat='start-api.bat'; Inst='';           Icon="$icons\api_server.ico,0"      },
    [pscustomobject]@{ Name='nifty50';     Bat='start-tfa.bat'; Inst=' nifty50';   Icon="$icons\tfa_nifty50.ico,0"    },
    [pscustomobject]@{ Name='banknifty';   Bat='start-tfa.bat'; Inst=' banknifty'; Icon="$icons\tfa_banknifty.ico,0"  },
    [pscustomobject]@{ Name='crudeoil';    Bat='start-tfa.bat'; Inst=' crudeoil';  Icon="$icons\tfa_crudeoil.ico,0"   },
    [pscustomobject]@{ Name='naturalgas';  Bat='start-tfa.bat'; Inst=' naturalgas';Icon="$icons\tfa_naturalgas.ico,0" },
    [pscustomobject]@{ Name='TFA Bot';     Bat='start-bot.bat'; Inst='';           Icon="$icons\tfa_bot.ico,0"        }
)

foreach ($s in $shortcuts) {
    $path = Join-Path $desktop ($s.Name + '.lnk')
    $lnk  = $wsh.CreateShortcut($path)
    $lnk.TargetPath       = 'cmd.exe'
    $lnk.Arguments        = '/k "cd /d "' + $root + '" && chcp 65001 >nul && call startup\' + $s.Bat + $s.Inst + '"'
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation     = $s.Icon
    $lnk.WindowStyle      = 1
    $lnk.Save()
    Write-Host "Created: $path"
}
