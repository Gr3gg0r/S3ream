import { DragEvent, useState } from "react";
import { SUPPORTED_VIDEO_EXTENSIONS } from "@shared/ipc";
import { Upload } from "@renderer/components/icons";

interface DropZoneProps {
  onFileSelected: (filePath: string, size?: number) => void;
  disabled?: boolean;
}

const supportedExtensions = new Set(SUPPORTED_VIDEO_EXTENSIONS);

const hasSupportedExtension = (name: string) => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) {
    return false;
  }
  return supportedExtensions.has(name.slice(dotIndex).toLowerCase());
};

export const DropZone = ({ onFileSelected, disabled }: DropZoneProps) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = async () => {
    if (!window.api || disabled) return;
    const selection = await window.api.selectVideo();
    if (selection) {
      setError(null);
      onFileSelected(selection);
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (disabled) return;
    setIsDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    // Dragleave also fires when moving over child elements; only clear on a real exit.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (disabled || !window.api) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!hasSupportedExtension(file.name)) {
      setError(`Unsupported file type: ${file.name}`);
      return;
    }
    const filePath = window.api.getPathForFile(file);
    if (!filePath) {
      setError("Could not resolve the dropped file path.");
      return;
    }
    setError(null);
    onFileSelected(filePath, file.size);
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="linear-dropzone"
        data-active={isDragActive}
        onClick={handleBrowse}
        onDragOver={handleDragEnter}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={disabled}
        aria-label="Drop a video file here, or activate to browse"
      >
        <Upload size={24} />
        <span className="text-[13px] font-medium">Drop a video file here</span>
        <span className="linear-hint">or click to browse — MP4, MOV, MKV, AVI, M4V, WEBM</span>
      </button>
      {error && (
        <span className="linear-hint text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
