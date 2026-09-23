'use client';
import React, { useRef, useEffect } from 'react';

const TestPasteContainer: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.focus();
      console.log("TestPasteContainer: Container focused");
    }
  }, []);

  useEffect(() => {
    const handleNativePaste = (event: ClipboardEvent) => {
      console.log("Native paste event fired:", event);
      const items = event.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          console.log(`Item ${i} type:`, items[i].type);
          if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onloadend = () => {
                console.log("Image data loaded:", reader.result);
              };
              reader.readAsDataURL(blob);
            }
            event.preventDefault();
            break;
          }
        }
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("paste", handleNativePaste);
    }
    return () => {
      if (container) {
        container.removeEventListener("paste", handleNativePaste);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      style={{
        border: "2px dashed blue",
        padding: "10px",
        minHeight: "200px",
        margin: "20px"
      }}
    >
      Click here and press Ctrl+V (or Cmd+V on macOS) to paste an image.
    </div>
  );
};

export default TestPasteContainer;
