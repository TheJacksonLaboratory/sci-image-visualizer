// dicom-parser ships no type declarations; this ambient shim lets the example
// compile. dicom.ts treats the module as `any` (it only calls parseDicom + the
// returned data set's uint16/string accessors).
declare module 'dicom-parser';
