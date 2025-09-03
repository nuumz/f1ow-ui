import { useEffect, useMemo, useRef } from 'react';
import { X, Copy, Download } from 'lucide-react';
import Modal from '../../core/Modal';

interface ExportPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  value: unknown; // raw JSON value (object)
  filename: string;
  onDownload: () => void;
}

export default function ExportPreviewModal({
  isOpen,
  onClose,
  value,
  filename,
  onDownload,
}: Readonly<ExportPreviewModalProps>) {
  const preRef = useRef<HTMLPreElement | null>(null);

  const jsonString = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '/* Unable to stringify workflow */';
    }
  }, [value]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && 'writeText' in navigator.clipboard) {
        await navigator.clipboard.writeText(jsonString);
      }
    } catch (err) {
      console.warn('Copy failed', err);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy="export-preview-title"
      className="export-preview-modal"
      withHeader={false}
    >
      <div className="modal-header">
        <h3 id="export-preview-title">
          Export Preview{' '}
          <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>{filename}</span>
        </h3>
        <button className="modal-close" onClick={onClose} aria-label="Close preview">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body">
        <pre
          ref={preRef}
          id="export-preview-content"
          className="json-preview"
          aria-label="Export JSON preview"
        >
          {jsonString}
        </pre>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={handleCopy} title="Copy JSON to clipboard">
          <Copy size={16} />
          <span>Copy</span>
        </button>
        <button className="btn btn-primary" onClick={onDownload} title="Download JSON file">
          <Download size={16} />
          <span>Download</span>
        </button>
      </div>
    </Modal>
  );
}
