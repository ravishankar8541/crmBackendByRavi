const nodemailer = require('nodemailer');

/*const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});  */

const transporter = nodemailer.createTransport({
   host: "smtp.titan.email",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});
 
const sendOfferLetter = async (to, offer) => {
  const pdfBuffer = await require('./pdfGenerator')(offer);

  // Professional Email Template
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
      <h2 style="color: #f27022;">Congratulations, ${offer.employeeName}!</h2>
      <p>Dear <strong>${offer.employeeName}</strong>,</p>
      
      <p>We are delighted to formally offer you the position of <strong>${offer.position}</strong> at <strong>Viral Ads Media</strong>. We were highly impressed with your skills and experience, and we believe you will be a fantastic addition to our team.</p>
      
      <p>Please find your official <strong>Offer Letter (Ref: ${offer.offerId})</strong> attached to this email. It outlines the terms of your employment, compensation, and joining details.</p>
      
      <div style="background: #f9f9f9; padding: 15px; border-left: 4px solid #f27022; margin: 20px 0;">
        <strong>Next Steps:</strong><br>
        1. Review the attached document carefully.<br>
        2. Sign and scan the acceptance copy.<br>
        3. Reply to this email with the signed document by <strong>${new Date(offer.joiningDate).toLocaleDateString()}</strong>.
      </div>
      
      <p>If you have any questions regarding the offer, please feel free to reach out to the HR department at this email address.</p>
      
      <p>We look forward to welcoming you to the team!</p>
      
      <p style="margin-top: 30px;">
        Best Regards,<br>
        <strong>HR Department</strong><br>
        Viral Ads Media | Digital Creative Agency
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"Viral Ads Media HR" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Job Offer: ${offer.position} | ${offer.employeeName}`,
    html: emailHtml, // Sending HTML instead of just text
    attachments: [{
      filename: `Offer_Letter_${offer.employeeName.replace(/\s+/g, '_')}.pdf`,
      content: pdfBuffer,
    }],
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (error) {
    console.error("Email Error:", error);
    throw new Error("Failed to send email");
  }
};

module.exports = sendOfferLetter;