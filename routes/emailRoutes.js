const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');

// Configure multer for memory storage (for PDF attachments)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'text/html') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and HTML files are allowed'), false);
    }
  }
});

// Email sending endpoint
router.post('/send-invoice', upload.single('bill'), async (req, res) => {
  try {
    const { to, subject, message, cc, bcc } = req.body;
    const file = req.file;

    if (!to) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email is required'
      });
    }

    if (!subject) {
      return res.status(400).json({
        success: false,
        message: 'Subject is required'
      });
    }

    // Configure nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail', // or use your email service
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    // Prepare email options
    const mailOptions = {
      from: `"Viral Ads Media" <${process.env.EMAIL_USER}>`,
      to: to,
      cc: cc || '',
      bcc: bcc || '',
      subject: subject,
      html: message || `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h2 style="color: #ea580c;">Viral Ads Media</h2>
            <p style="color: #64748b;">Invoice Management System</p>
          </div>
          <div style="background-color: #f8fafc; padding: 20px; border-radius: 10px; border: 1px solid #e2e8f0;">
            <p>Dear Customer,</p>
            <p>Please find attached your invoice for the services provided.</p>
            <p style="color: #64748b; font-size: 14px;">If you have any questions, please don't hesitate to contact us.</p>
          </div>
          <div style="margin-top: 20px; text-align: center; color: #94a3b8; font-size: 12px;">
            <p>Viral Ads Media - B-27, Khatu shyam Mandir Road, New Delhi</p>
            <p>Phone: +91 93544 91934 | Email: info@viraladsmedia.com</p>
          </div>
        </div>
      `,
      attachments: file ? [{
        filename: file.originalname || 'invoice.pdf',
        content: file.buffer,
        contentType: file.mimetype || 'application/pdf'
      }] : []
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email sent successfully:', info.messageId);

    return res.status(200).json({
      success: true,
      message: 'Email sent successfully!',
      messageId: info.messageId
    });

  } catch (error) {
    console.error('❌ Email sending error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send email',
      error: error.message
    });
  }
});

// Test email endpoint
router.post('/test-email', async (req, res) => {
  try {
    const { to } = req.body;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    const mailOptions = {
      from: `"Viral Ads Media" <${process.env.EMAIL_USER}>`,
      to: to || process.env.EMAIL_USER,
      subject: 'Test Email from Viral Ads Media',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #ea580c;">✅ Email Configuration Test</h2>
          <p>Your email configuration is working perfectly!</p>
          <p style="color: #64748b;">This is a test email from Viral Ads Media Invoice System.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({
      success: true,
      message: 'Test email sent successfully!'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Test email failed',
      error: error.message
    });
  }
});

module.exports = router;