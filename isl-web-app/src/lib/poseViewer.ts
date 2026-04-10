let poseViewerReady: Promise<void> | null = null;

export async function ensurePoseViewerDefined(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  if (customElements.get('pose-viewer')) {
    return;
  }

  if (!poseViewerReady) {
    poseViewerReady = import('pose-viewer/loader').then(({defineCustomElements}) => {
      defineCustomElements();
    });
  }

  return poseViewerReady;
}

