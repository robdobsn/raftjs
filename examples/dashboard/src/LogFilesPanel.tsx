import React, { useEffect, useState } from 'react';
import ConnManager from './ConnManager';
import './styles.css';

const connManager = ConnManager.getInstance();

interface LogFilesPanelProps {
  refreshTrigger?: number;
  onDownloadActiveChange?: (active: boolean) => void;
}

export default function LogFilesPanel({ refreshTrigger, onDownloadActiveChange }: LogFilesPanelProps) {
  const [files, setFiles] = useState<{name: string, size: number}[]>([]);
  const [diskSize, setDiskSize] = useState(0);
  const [diskUsed, setDiskUsed] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [lastError, setLastError] = useState('');

  const fetchFiles = async () => {
    if (!connManager.getConnector().isConnected()) return;
    setIsLoading(true);
    setLastError('');
    try {
      // Request file listing for the logs folder on local filesystem
      const resp = await connManager.getConnector().sendRICRESTMsg(
        'filelist/local/logs', {}
      );
      const fileList = typeof resp === 'string' ? JSON.parse(resp) : resp;
      setFiles((fileList.files || []).sort((a: {name: string}, b: {name: string}) => b.name.localeCompare(a.name)));
      setDiskSize(fileList.diskSize || 0);
      setDiskUsed(fileList.diskUsed || 0);
    } catch (e) {
      console.warn('Failed to get file list', e);
      setLastError('Failed to get file list');
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchFiles();
  }, [refreshTrigger]);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleDownload = async (file: {name: string, size: number}) => {
    // Estimate download time and warn user for large transfers
    const connMethod = connManager.getConnector().getConnMethod();
    const isBLE = connMethod === 'WebBLE' || connMethod === 'PhoneBLE';
    const estimatedBytesPerSec = isBLE ? 5000 : 50000;
    const estimatedTimeSec = file.size / estimatedBytesPerSec;

    if (estimatedTimeSec > 30) {
      const timeStr = estimatedTimeSec >= 60
        ? `${Math.round(estimatedTimeSec / 60)} min ${Math.round(estimatedTimeSec % 60)} sec`
        : `${Math.round(estimatedTimeSec)} sec`;
      const confirmed = window.confirm(
        `Download ${file.name} (${formatBytes(file.size)})?\n\n` +
        `Estimated time over ${connMethod}: ~${timeStr}\n\n` +
        `Continue?`
      );
      if (!confirmed) return;
    }

    setDownloadingFile(file.name);
    setDownloadProgress(0);
    setLastError('');
    onDownloadActiveChange?.(true);
    try {
      // Download from local/logs/<filename>
      const filePath = `local/logs/${file.name}`;
      const result = await connManager.getConnector().fsGetContents(
        filePath,
        'fs',
        (received: number, total: number) => {
          if (total > 0) {
            setDownloadProgress(Math.round((received / total) * 100));
          }
        }
      );

      if (result.downloadedOk && result.fileData) {
        // Trigger browser download
        const blob = new Blob([result.fileData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        setLastError(`Failed to download ${file.name}`);
      }
    } catch (e) {
      console.warn('Download failed', e);
      setLastError(`Download error: ${file.name}`);
    }
    setDownloadingFile(null);
    setDownloadProgress(0);
    onDownloadActiveChange?.(false);
  };

  const handleDelete = async (file: {name: string, size: number}) => {
    const confirmed = window.confirm(`Delete ${file.name} (${formatBytes(file.size)})?`);
    if (!confirmed) return;

    setDeletingFile(file.name);
    setLastError('');
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(
        `filedelete/local/logs/${file.name}`, {}
      );
      const r = resp as any;
      if (r?.rslt === 'ok') {
        await fetchFiles();
      } else {
        setLastError(`Failed to delete ${file.name}`);
      }
    } catch (e) {
      console.warn('Delete failed', e);
      setLastError(`Delete error: ${file.name}`);
    }
    setDeletingFile(null);
  };

  return (
    <div className="info-box log-files-panel">
      <div className="log-files-header">
        <h3>Log Files</h3>
        <button
          className="log-files-refresh-button"
          onClick={fetchFiles}
          disabled={isLoading}
          title="Refresh file list"
        >
          ↻
        </button>
      </div>

      {diskSize > 0 && (
        <div className="log-files-disk-info">
          {formatBytes(diskUsed)} / {formatBytes(diskSize)} used
        </div>
      )}

      {isLoading ? (
        <div className="log-files-loading">Loading...</div>
      ) : files.length === 0 ? (
        <div className="log-files-empty">No log files found</div>
      ) : (
        <div className="log-files-list">
          {files.map((file) => {
            const isDownloading = downloadingFile === file.name;

            return (
              <div key={file.name} className="log-file-item">
                <div className="log-file-info">
                  <div className="log-file-name" title={file.name}>
                    {file.name}
                  </div>
                  <div className="log-file-size">{formatBytes(file.size)}</div>
                </div>
                <div className="log-file-actions">
                  <button
                    className="log-file-download-button"
                    onClick={() => handleDownload(file)}
                    disabled={isDownloading || downloadingFile !== null || deletingFile !== null}
                    title={`Download ${file.name}`}
                  >
                    {isDownloading ? `${downloadProgress}%` : '⬇'}
                  </button>
                  <button
                    className="log-file-delete-button"
                    onClick={() => handleDelete(file)}
                    disabled={isDownloading || downloadingFile !== null || deletingFile === file.name}
                    title={`Delete ${file.name}`}
                  >
                    {deletingFile === file.name ? '...' : '🗑'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lastError && (
        <div className="logging-error">{lastError}</div>
      )}
    </div>
  );
}
