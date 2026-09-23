# Downloads the MediaPipe FaceLandmarker model used for drowsiness detection (~3.7 MB).
$dest = Join-Path $PSScriptRoot "face_landmarker.task"
Invoke-WebRequest "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" -OutFile $dest
Write-Host "Saved $dest"
