$ErrorActionPreference = 'Continue'
$P  = 'C:\bhr\roger-android'
$T  = 'C:\bhr\android-tools'
$BT = "$T\sdk\build-tools\34.0.0"
$AJ = "$T\sdk\platforms\android-34\android.jar"
$PUB = $env:ROGER_PUBLIC
$VC = 7; $VN = '7.0'           # bump both for every new release of the app
$env:JAVA_HOME = "$T\jdk"; $env:Path = "$T\jdk\bin;$env:Path"
Set-Location $P

# icons
foreach ($d in 'hdpi','xhdpi','xxhdpi','xxxhdpi') {
  New-Item -ItemType Directory -Force "$P\res\mipmap-$d" | Out-Null
  Copy-Item "$PUB\icon-192.png" "$P\res\mipmap-$d\ic_launcher.png" -Force
}

# signing key (created once; keep it, future updates must be signed with the same one)
if (-not ((Test-Path "$P\roger-release.jks") -and (Test-Path "$P\keystore.pass"))) {
  Remove-Item "$P\roger-release.jks" -ErrorAction SilentlyContinue
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Set-Content -NoNewline -Encoding ascii "$P\keystore.pass" $pw
  & keytool -genkeypair -keystore "$P\roger-release.jks" -storepass $pw -keypass $pw -alias roger -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Roger Radio" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$pw = Get-Content -Raw "$P\keystore.pass"

# build
Remove-Item -Recurse -Force "$P\build" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$P\build\classes","$P\build\dex" | Out-Null
& "$BT\aapt2.exe" compile --dir "$P\res" -o "$P\build\res.zip"; if ($LASTEXITCODE) { throw 'aapt2 compile' }
& "$BT\aapt2.exe" link -o "$P\build\base.apk" -I $AJ --manifest "$P\AndroidManifest.xml" --min-sdk-version 24 --target-sdk-version 34 --version-code $VC --version-name $VN "$P\build\res.zip"; if ($LASTEXITCODE) { throw 'aapt2 link' }
$srcs = Get-ChildItem "$P\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& javac --release 8 -Xlint:-options -cp $AJ -d "$P\build\classes" $srcs; if ($LASTEXITCODE) { throw 'javac' }
$cls = Get-ChildItem "$P\build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$BT\d8.bat" --lib $AJ --release --min-api 24 --output "$P\build\dex" $cls; if ($LASTEXITCODE) { throw 'd8' }
Push-Location "$P\build\dex"; & "$BT\aapt.exe" add "$P\build\base.apk" classes.dex | Out-Null; Pop-Location
& "$BT\zipalign.exe" -f -p 4 "$P\build\base.apk" "$P\build\aligned.apk"; if ($LASTEXITCODE) { throw 'zipalign' }
& "$BT\apksigner.bat" sign --ks "$P\roger-release.jks" --ks-pass "pass:$pw" --key-pass "pass:$pw" --ks-key-alias roger --out "$P\Roger.apk" "$P\build\aligned.apk"; if ($LASTEXITCODE) { throw 'apksigner' }
& "$BT\apksigner.bat" verify --verbose "$P\Roger.apk" | Select-String 'Verifies|scheme'
"APK: " + [math]::Round((Get-Item "$P\Roger.apk").Length / 1KB) + " KB"

# publish: the server hands out the APK and a version file; installed apps read the version file when they start
$sha = (Get-FileHash "$P\Roger.apk" -Algorithm SHA256).Hash.ToLower()
$json = (@{ versionCode = $VC; versionName = $VN; url = '/Roger.apk'; sha256 = $sha } | ConvertTo-Json)
foreach ($dir in @($PUB, (Join-Path (Split-Path $PUB -Parent) 'github-upload\public'))) {
  if (Test-Path $dir) { Copy-Item "$P\Roger.apk" "$dir\Roger.apk" -Force; Set-Content "$dir\android-version.json" $json -Encoding ascii; "published to $dir" }
}




