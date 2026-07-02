const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../uploads/invoices');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.html';
    cb(null, `invoice-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/html', 'application/pdf', 'application/octet-stream'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.endsWith('.html')) {
      cb(null, true);
    } else {
      cb(new Error('Only HTML and PDF files are allowed'), false);
    }
  }
});

// Upload invoice endpoint
router.post('/upload-invoice', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/invoices/${req.file.filename}`;
    
    console.log('✅ PDF uploaded:', req.file.filename);
    console.log('📎 URL:', fileUrl);

    res.json({
      success: true,
      url: fileUrl,
      filename: req.file.filename,
      message: 'PDF uploaded successfully!'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get all uploaded invoices
router.get('/invoices', (req, res) => {
  try {
    const files = fs.readdirSync(uploadDir);
    const invoices = files.map(file => ({
      filename: file,
      url: `${req.protocol}://${req.get('host')}/uploads/invoices/${file}`,
      uploadedAt: fs.statSync(path.join(uploadDir, file)).mtime
    }));
    res.json({ success: true, data: invoices });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete invoice
router.delete('/invoices/:filename', (req, res) => {
  try {
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true, message: 'Invoice deleted successfully' });
    } else {
      res.status(404).json({ success: false, message: 'File not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;