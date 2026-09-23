'use client'

import React, { useState } from 'react'
import { FiCopy } from 'react-icons/fi'

interface CopyButtonProps {
  text: string
}

export function CopyButton({ text }: CopyButtonProps): JSX.Element {
  const [justCopied, setJustCopied] = useState(false)

  const handleClick = () => {
    navigator.clipboard.writeText(text)
    setJustCopied(true)
    setTimeout(() => setJustCopied(false), 1500)
  }

  return (
    <button
      onClick={handleClick}
      className="copy-button"
      aria-label="Copy DOI"
      title={justCopied ? 'Copied!' : 'Copy'}
    >
      <FiCopy />
      {justCopied && <span className="copy-tooltip">Copied!</span>}
    </button>
  )
}
