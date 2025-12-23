import Papa from "papaparse";

export function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: reject,
    });
  });
}

export function downloadCSV(filename, rows, fieldnames) {
  const csv = Papa.unparse(
    rows.map((r) => {
      const o = {};
      fieldnames.forEach((f) => (o[f] = r[f] ?? ""));
      return o;
    }),
    { columns: fieldnames }
  );

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
