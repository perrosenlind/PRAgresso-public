// Runs at document_start, before Agresso paints anything. It only marks the
// page with the widescreen layout the user chose, read synchronously from
// this origin's localStorage (cells.js keeps that copy in step with the
// setting). styles.css keys the two-column grid off the mark with :has(), so
// the column beside Tidtransaktion is reserved from the very first frame.
// Without this the grid painted full width and narrowed a moment later —
// on every postback, since each one replaces the document.
try {
  const mode = localStorage.getItem('pragresso_wide_layout');
  if (mode === 'right' || mode === 'rail') {
    document.documentElement.setAttribute('data-pragresso-wide-pref', mode);
    if (localStorage.getItem('pragresso_wide_details') === '1') {
      document.documentElement.setAttribute('data-pragresso-wide-details', '');
    }
    if (localStorage.getItem('pragresso_wide_folded') === '1') {
      document.documentElement.setAttribute('data-pragresso-wide-folded', '');
    }
  }
} catch (e) { /* storage blocked: cells.js still builds the layout */ }
