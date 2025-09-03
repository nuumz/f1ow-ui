import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  ariaLabelledBy?: string;
  // When true, clicking on the backdrop closes the modal (default true)
  closeOnBackdrop?: boolean;
  // Additional class on dialog container
  className?: string;
  // Render header with title + close button (default true)
  withHeader?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  title,
  ariaLabelledBy,
  closeOnBackdrop = true,
  className,
  withHeader = true,
  children,
}: React.PropsWithChildren<ModalProps>) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

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

  return createPortal(
    <>
      {closeOnBackdrop ? (
        <button
          type="button"
          className="modal-backdrop"
          onClick={onClose}
          aria-label="Close modal"
        />
      ) : (
        <div className="modal-backdrop" aria-hidden="true" />
      )}
      <div className="modal">
        <div
          ref={dialogRef}
          className={`modal-dialog ${className ?? ''}`.trim()}
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
        >
          {withHeader && (
            <div className="modal-header">
              <h3 id={ariaLabelledBy}>{title}</h3>
              <button className="modal-close" onClick={onClose} aria-label="Close">
                ×
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
    </>,
    document.body
  );
}

export default Modal;
