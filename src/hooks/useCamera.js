import { useCallback, useEffect, useRef, useState } from "react";

// 摄像头：开启/关闭/重试，画面只在本机渲染，不落盘、不上传。
export default function useCamera({ initialOn = false } = {}) {
  const [cameraOn, setCameraOn] = useState(initialOn);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const cameraBusyRef = useRef(false);

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraStarting(true);
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("当前浏览器不支持摄像头");
      setCameraStarting(false);
      cameraBusyRef.current = false;
      return;
    }
    try {
      stopCameraStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      streamRef.current = stream;
      setCameraOn(true);
      setCameraError("");
      setCameraStarting(false);
    } catch (err) {
      setCameraOn(false);
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCameraError("摄像头权限被拒绝：请在浏览器地址栏允许摄像头权限后，再点“重试开启摄像头”。");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCameraError("没有检测到可用摄像头；可以插好摄像头后重试，语音面试不受影响。");
      } else {
        setCameraError("摄像头暂时无法打开，可稍后点“重试开启摄像头”，或直接继续语音面试。");
      }
      setCameraStarting(false);
    } finally {
      cameraBusyRef.current = false;
    }
  }, [stopCameraStream]);

  const toggleCamera = useCallback(() => {
    if (cameraOn) {
      stopCameraStream();
      setCameraOn(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    } else {
      startCamera();
    }
  }, [cameraOn, startCamera, stopCameraStream]);

  useEffect(() => {
    if (cameraOn && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraOn]);

  return { cameraOn, cameraStarting, cameraError, videoRef, startCamera, stopCameraStream, toggleCamera };
}
