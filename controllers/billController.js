const Bill = require('../models/Bill');
const Client = require('../models/Client');
const ServiceBill = require('../models/ServiceBill');
const PDFDocument = require('pdfkit');

const generateBillNumber = async (retryCount = 0) => {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const date = String(new Date().getDate()).padStart(2, '0');

    // Get last bill number for this month
    const lastBill = await Bill.findOne({
        billNumber: { $regex: `INV/${year}/${month}` }
    }).sort({ createdAt: -1 });

    let sequence = 1;
    if (lastBill) {
        const lastSequence = parseInt(lastBill.billNumber.split('/').pop());
        sequence = lastSequence + 1;
    }

    const billNumber = `INV/${year}/${month}/${String(sequence).padStart(4, '0')}`;

    // Check if bill number already exists (double check)
    const exists = await Bill.findOne({ billNumber });
    if (exists && retryCount < 5) {
        return generateBillNumber(retryCount + 1);
    }

    return billNumber;
};

// Helper function to calculate GST
const calculateGST = (amount, gstRate, taxType = 'CGST+SGST') => {
    const gstAmount = (amount * gstRate) / 100;

    if (taxType === 'IGST') {
        return {
            gstAmount: gstAmount,
            cgst: 0,
            sgst: 0,
            igst: gstAmount
        };
    } else {
        return {
            gstAmount: gstAmount,
            cgst: gstAmount / 2,
            sgst: gstAmount / 2,
            igst: 0
        };
    }
};
exports.createBill = async (req, res) => {
    try {
        const {
            clientId,
            serviceName,
            description,
            totalAmount,
            dueDate,
            gstAmount,
            notes,
            initialPayment,
            paymentMethod,
            transactionId,
            paymentRemarks,
            services
        } = req.body;

        // Validate required fields
        if (!clientId) {
            return res.status(400).json({
                success: false,
                message: 'Client ID is required'
            });
        }

        const client = await Client.findById(clientId);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const billNumber = await generateBillNumber();

        let parsedTotalAmount = 0;
        let parsedSubtotal = 0;
        let parsedTotalGst = 0;

        // Check if this is a multiple services bill
        if (services && Array.isArray(services) && services.length > 0) {
            for (const service of services) {
                const quantity = service.quantity || 1;
                const unitPrice = parseFloat(service.unitPrice) || 0;
                const totalPrice = quantity * unitPrice;
                const gstRate = parseFloat(service.gstRate) || 0;
                const gstAmountCalc = (totalPrice * gstRate) / 100;

                parsedSubtotal += totalPrice;
                parsedTotalGst += gstAmountCalc;
            }

            let discountAmount = 0;
            if (req.body.discount) {
                const discount = parseFloat(req.body.discount) || 0;
                const discountType = req.body.discountType || 'percentage';
                if (discountType === 'percentage') {
                    discountAmount = (parsedSubtotal * discount) / 100;
                } else {
                    discountAmount = discount;
                }
            }
            parsedTotalAmount = parsedSubtotal + parsedTotalGst - discountAmount;
        } else {
            parsedTotalAmount = parseFloat(totalAmount) || 0;
        }

        const parsedInitialPayment = parseFloat(initialPayment) || 0;

        if (parsedInitialPayment > parsedTotalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Initial payment cannot exceed total amount'
            });
        }

        // 🔴 FIX: Get display service name for bills table
        let displayServiceName = serviceName || '';
        if ((!displayServiceName || displayServiceName === '') && services && services.length > 0) {
            const serviceNames = services.map(s => s.serviceName).filter(n => n && n !== '');
            displayServiceName = serviceNames.join(', ');
            if (displayServiceName.length > 50) {
                displayServiceName = displayServiceName.substring(0, 47) + '...';
            }
        }
        if (!displayServiceName || displayServiceName === '') {
            displayServiceName = 'Multi-Service Bill';
        }

        const newBill = new Bill({
            billNumber,
            clientId,
            serviceName: displayServiceName,  // ← FIXED
            description: description || '',
            totalAmount: parsedTotalAmount,
            dueDate: new Date(dueDate),
            gstAmount: parseFloat(gstAmount) || parsedTotalGst,
            notes: notes || '',
            createdBy: req.user?.username || 'System',
            paidAmount: parsedInitialPayment,
            subtotal: parsedSubtotal,
            totalGstAmount: parsedTotalGst,
            discount: parseFloat(req.body.discount) || 0,
            discountType: req.body.discountType || 'percentage'
        });

        newBill.dueAmount = parsedTotalAmount - parsedInitialPayment;
        newBill.calculateBill();
        if (parsedInitialPayment > 0) {
            newBill.payments.push({
                amount: parsedInitialPayment,
                paymentMethod: paymentMethod || 'Cash',
                transactionId: transactionId || '',
                remarks: paymentRemarks || 'Initial payment at bill creation',
                receivedBy: req.user?.username || 'System',
                paymentDate: new Date()
            });
        }

        if (services && Array.isArray(services) && services.length > 0) {
            const processedServices = [];
            for (const service of services) {
                const quantity = service.quantity || 1;
                const unitPrice = parseFloat(service.unitPrice) || 0;
                const totalPrice = quantity * unitPrice;
                const gstRate = parseFloat(service.gstRate) || 0;
                const gstAmountCalc = (totalPrice * gstRate) / 100;

                processedServices.push({
                    serviceName: service.serviceName,
                    description: service.description || '',
                    quantity: quantity,
                    unitPrice: unitPrice,
                    totalPrice: totalPrice,
                    gstRate: gstRate,
                    gstAmount: gstAmountCalc,
                    cgst: gstAmountCalc / 2,
                    sgst: gstAmountCalc / 2,
                    igst: 0
                });
            }
            newBill.services = processedServices;
        }

        await newBill.save();
        console.log("✅ Bill saved successfully:", billNumber);

        await newBill.populate('clientId', 'name companyName email phone address gstNumber');

        // ServiceBill creation logic
        let serviceBillCreated = false;

        try {
            console.log("🟢 Starting ServiceBill creation/update...");

            // For single service
            if (serviceName && !services) {
                let serviceBill = await ServiceBill.findOne({
                    clientId: clientId,
                    serviceName: serviceName
                });

                if (!serviceBill) {
                    serviceBill = new ServiceBill({
                        clientId: clientId,
                        serviceName: serviceName,
                        totalAmount: parsedTotalAmount,
                        paidAmount: parsedInitialPayment,
                        dueAmount: parsedTotalAmount - parsedInitialPayment,
                        status: parsedInitialPayment >= parsedTotalAmount ? 'Paid' : (parsedInitialPayment > 0 ? 'Partially Paid' : 'Pending'),
                        bills: [{ billId: newBill._id, billNumber: billNumber, amount: parsedTotalAmount, paymentReceived: parsedInitialPayment, date: new Date() }]
                    });
                } else {
                    serviceBill.paidAmount += parsedInitialPayment;
                    serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
                    serviceBill.status = serviceBill.paidAmount >= serviceBill.totalAmount ? 'Paid' : (serviceBill.paidAmount > 0 ? 'Partially Paid' : 'Pending');

                    serviceBill.bills.push({
                        billId: newBill._id,
                        billNumber: billNumber,
                        amount: parsedTotalAmount,
                        paymentReceived: parsedInitialPayment,
                        date: new Date()
                    });
                }

                if (parsedInitialPayment > 0) {
                    serviceBill.payments.push({
                        amount: parsedInitialPayment,
                        paymentMethod: paymentMethod || 'Cash',
                        transactionId: transactionId || '',
                        remarks: paymentRemarks || 'Payment',
                        receivedBy: req.user?.username || 'System',
                        billNumber: billNumber
                    });
                }

                await serviceBill.save();
            }

            // For multiple services
            if (services && services.length > 0) {
                console.log("📌 Processing MULTIPLE services, count:", services.length);

                for (const service of services) {
                    console.log(`   Processing service: ${service.serviceName}`);

                    let serviceBill = await ServiceBill.findOne({
                        clientId: clientId,
                        serviceName: service.serviceName
                    });

                    const quantity = service.quantity || 1;
                    const unitPrice = parseFloat(service.unitPrice) || 0;
                    const totalPrice = quantity * unitPrice;
                    const gstRate = parseFloat(service.gstRate) || 0;
                    const gstAmountCalc = (totalPrice * gstRate) / 100;
                    const serviceTotal = totalPrice + gstAmountCalc;

                    const proportionalPayment = parsedInitialPayment > 0 && parsedTotalAmount > 0 ?
                        (parsedInitialPayment * serviceTotal) / parsedTotalAmount : 0;

                    if (!serviceBill) {
                        console.log(`   🆕 Creating NEW ServiceBill for: ${service.serviceName}`);
                        serviceBill = new ServiceBill({
                            clientId: clientId,
                            serviceName: service.serviceName,
                            totalAmount: serviceTotal,
                            paidAmount: proportionalPayment,
                            dueAmount: serviceTotal - proportionalPayment,
                            status: proportionalPayment >= serviceTotal ? 'Paid' :
                                proportionalPayment > 0 ? 'Partially Paid' : 'Pending',
                            bills: [{
                                billId: newBill._id,
                                billNumber: billNumber,
                                amount: serviceTotal,
                                paymentReceived: proportionalPayment,
                                date: new Date()
                            }]
                        });
                    } else {
                        console.log(`   📝 UPDATING existing ServiceBill for: ${service.serviceName}`);
                        console.log(`      Old total: ${serviceBill.totalAmount}, Old paid: ${serviceBill.paidAmount}`);

                        serviceBill.totalAmount += serviceTotal;
                        serviceBill.paidAmount += proportionalPayment;
                        serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
                        serviceBill.status = serviceBill.paidAmount >= serviceBill.totalAmount ? 'Paid' :
                            serviceBill.paidAmount > 0 ? 'Partially Paid' : 'Pending';

                        serviceBill.bills.push({
                            billId: newBill._id,
                            billNumber: billNumber,
                            amount: serviceTotal,
                            paymentReceived: proportionalPayment,
                            date: new Date()
                        });
                    }

                    if (proportionalPayment > 0) {
                        serviceBill.payments.push({
                            amount: proportionalPayment,
                            paymentMethod: paymentMethod || 'Cash',
                            transactionId: transactionId || '',
                            remarks: paymentRemarks || 'Initial payment',
                            receivedBy: req.user?.username || 'System',
                            billNumber: billNumber
                        });
                    }

                    await serviceBill.save();
                    console.log(`   ✅ ServiceBill saved for: ${service.serviceName}`);
                }
                serviceBillCreated = true;
            }

            if (!serviceBillCreated) {
                console.log("⚠️ No service bill was created - no service name provided");
            }

        } catch (serviceBillError) {
            console.error('❌ Error updating service bill:', serviceBillError);
            console.error('Error details:', serviceBillError.message);
        }

        console.log("========================================");
        console.log("🎉 Bill creation completed!");
        console.log("   Bill Number:", billNumber);
        console.log("========================================");

        return res.status(201).json({
            success: true,
            message: parsedInitialPayment > 0 ? 'Bill created with initial payment' : 'Bill created successfully',
            data: newBill
        });

    } catch (error) {
        console.error('❌ Create bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while creating bill',
            error: error.message
        });
    }
};

// Get all bills with filters
exports.getBills = async (req, res) => {
    try {
        const {
            status,
            clientId,
            startDate,
            endDate,
            page = 1,
            limit = 50
        } = req.query;

        let query = {};

        if (status && status !== 'All') query.status = status;
        if (clientId) query.clientId = clientId;

        if (startDate || endDate) {
            query.billDate = {};
            if (startDate) query.billDate.$gte = new Date(startDate);
            if (endDate) query.billDate.$lte = new Date(endDate);
        }

        const bills = await Bill.find(query)
            .populate('clientId', 'name companyName email phone')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        const total = await Bill.countDocuments(query);

        return res.status(200).json({
            success: true,
            data: bills,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Get bills error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching bills',
            error: error.message
        });
    }
};

// Get single bill by ID
exports.getBillById = async (req, res) => {
    try {
        const bill = await Bill.findById(req.params.id)
            .populate('clientId', 'name companyName email phone address gstNumber');

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: bill
        });

    } catch (error) {
        console.error('Get bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching bill',
            error: error.message
        });
    }
};

exports.addPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, paymentMethod, transactionId, remarks } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid payment amount is required'
            });
        }

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Bill is already fully paid'
            });
        }

        const paymentAmount = parseFloat(amount);

        if (paymentAmount > bill.dueAmount) {
            return res.status(400).json({
                success: false,
                message: `Payment amount cannot exceed due amount of ₹${bill.dueAmount.toLocaleString('en-IN')}`
            });
        }

        const payment = {
            amount: paymentAmount,
            paymentMethod: paymentMethod || 'Cash',
            transactionId: transactionId || '',
            remarks: remarks || '',
            receivedBy: req.user?.username || 'System',
            paymentDate: new Date()
        };

        bill.payments.push(payment);
        bill.paidAmount += paymentAmount;
        // ✅ CRITICAL: Update due amount
        bill.dueAmount = bill.totalAmount - bill.paidAmount;

        // Update status
        if (bill.dueAmount <= 0) {
            bill.status = 'Paid';
        } else if (bill.paidAmount > 0) {
            bill.status = 'Partially Paid';
        }

        await bill.save();
        await bill.populate('clientId', 'name companyName email phone');

        return res.status(200).json({
            success: true,
            message: 'Payment added successfully',
            data: bill
        });

    } catch (error) {
        console.error('Add payment error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while adding payment',
            error: error.message
        });
    }
};

// Update bill
exports.updateBill = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Cannot edit a paid bill'
            });
        }

        const allowedUpdates = ['serviceName', 'description', 'totalAmount', 'dueDate', 'gstAmount', 'notes'];

        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                if (field === 'totalAmount') {
                    bill[field] = parseFloat(updates[field]);
                } else if (field === 'dueDate') {
                    bill[field] = new Date(updates[field]);
                } else if (field === 'gstAmount') {
                    bill[field] = parseFloat(updates[field]) || 0;
                } else {
                    bill[field] = updates[field];
                }
            }
        });

        if (bill.calculateBill) {
            bill.calculateBill();
        }

        await bill.save();
        await bill.populate('clientId', 'name companyName email phone');

        return res.status(200).json({
            success: true,
            message: 'Bill updated successfully',
            data: bill
        });

    } catch (error) {
        console.error('Update bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while updating bill',
            error: error.message
        });
    }
};

// Delete bill
exports.deleteBill = async (req, res) => {
    try {
        const { id } = req.params;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.payments && bill.payments.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete bill with existing payments'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete a paid bill'
            });
        }

        await Bill.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: 'Bill deleted successfully'
        });

    } catch (error) {
        console.error('Delete bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while deleting bill',
            error: error.message
        });
    }
};

// Get client billing summary
exports.getClientBillingSummary = async (req, res) => {
    try {
        const { clientId } = req.params;

        // Validate clientId
        if (!clientId || clientId === 'undefined' || clientId === 'null') {
            return res.status(400).json({
                success: false,
                message: 'Valid client ID is required'
            });
        }

        // Get ALL bills including installment bills
        const bills = await Bill.find({ clientId: clientId }).sort({ billDate: -1 });

        console.log(`📊 Found ${bills.length} bills for client ${clientId}`);

        const summary = {
            totalBilled: 0,
            totalPaid: 0,
            totalDue: 0,
            billsCount: bills.length,
            overdueBills: 0,
            bills: bills.map(bill => ({
                _id: bill._id,
                billNumber: bill.billNumber,
                totalAmount: bill.totalAmount,
                paidAmount: bill.paidAmount,
                dueAmount: bill.dueAmount,
                status: bill.status,
                dueDate: bill.dueDate,
                billDate: bill.billDate,
                serviceName: bill.serviceName || (bill.services && bill.services[0]?.serviceName) || 'Installment Bill'
            }))
        };

        bills.forEach(bill => {
            summary.totalBilled += bill.totalAmount;
            summary.totalPaid += bill.paidAmount;
            summary.totalDue += bill.dueAmount;
            if (bill.status === 'Overdue') summary.overdueBills++;
        });

        return res.status(200).json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('Get client billing summary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching client billing summary',
            error: error.message
        });
    }
};

// Get payment history
exports.getPaymentHistory = async (req, res) => {
    try {
        const { id } = req.params;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: bill.payments
        });

    } catch (error) {
        console.error('Get payment history error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching payment history',
            error: error.message
        });
    }
};

// Download bill as PDF - PERFECT DESIGN MATCHING SAMPLE INVOICE
exports.downloadBill = async (req, res) => {
    try {
        const bill = await Bill.findById(req.params.id)
            .populate('clientId', 'name companyName email phone address gstNumber');

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        // Set response headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${bill.billNumber}.pdf"`);

        // Create PDF document
        const doc = new PDFDocument({
            margin: 50,
            size: 'A4'
        });

        doc.pipe(res);

        // ========== HEADER WITH BORDER ==========
        // Top border line
        doc.strokeColor('#000000').lineWidth(1)
            .moveTo(50, 50)
            .lineTo(550, 50)
            .stroke();

        doc.moveDown(0.5);

        // Company Name - Large Font
        doc.fontSize(24)
            .font('Helvetica-Bold')
            .fillColor('#000000')
            .text('VIRAL ADS MEDIA', { align: 'center' });

        doc.moveDown(0.3);

        // Company Address
        doc.fontSize(9)
            .font('Helvetica')
            .fillColor('#333333')
            .text('B-27, Khatu shyam Mandir Road, near Max Bazar, Budh Vihar Phase I', { align: 'center' });
        doc.text('New Delhi, Delhi, India - 110086', { align: 'center' });
        doc.text('GSTIN: 07DTXPK7339P1ZF | PAN: DTXPK7339P', { align: 'center' });
        doc.text('Email: info@viraladsmedia.com | Phone: +91 93544 91934', { align: 'center' });

        doc.moveDown(0.8);

        // Decorative line
        doc.strokeColor('#000000').lineWidth(0.5)
            .moveTo(50, doc.y)
            .lineTo(550, doc.y)
            .stroke();

        doc.moveDown(1);

        // ========== INVOICE TITLE SECTION ==========
        doc.fontSize(18)
            .font('Helvetica-Bold')
            .fillColor('#000000')
            .text('INVOICE', { align: 'center' });

        doc.moveDown(0.5);

        // Invoice Number and Date - Right Aligned
        doc.fontSize(10)
            .font('Helvetica')
            .fillColor('#000000');

        // Get invoice number without slashes for display
        const displayBillNumber = bill.billNumber.replace(/\//g, '#');

        doc.text(`Invoice No # ${displayBillNumber}`, { align: 'right' });
        doc.text(`Invoice Date ${new Date(bill.billDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`, { align: 'right' });

        doc.moveDown(1.5);

        // ========== BILLED BY & BILLED TO SECTION ==========
        const startY = doc.y;

        // Billed By Section
        doc.fontSize(10)
            .font('Helvetica-Bold')
            .fillColor('#000000')
            .text('Billed By', 50, startY);

        doc.fontSize(9)
            .font('Helvetica')
            .fillColor('#333333');

        let billedByY = startY + 15;
        doc.text('Viral Ads Media', 50, billedByY);
        doc.text('B-27, Khatu shyam Mandir Road, near Max Bazar,', 50, billedByY + 15);
        doc.text('Budh Vihar Phase I, New Delhi, Delhi,', 50, billedByY + 30);
        doc.text('India - 110086', 50, billedByY + 45);
        doc.text('GSTIN: 07DTXPK7339P1ZF', 50, billedByY + 60);
        doc.text('PAN: DTXPK7339P', 50, billedByY + 75);
        doc.text('Email: info@viraladsmedia.com', 50, billedByY + 90);
        doc.text('Phone: +91 93544 91934', 50, billedByY + 105);

        // Billed To Section
        doc.font('Helvetica-Bold')
            .fillColor('#000000')
            .text('Billed To', 310, startY);

        doc.font('Helvetica')
            .fillColor('#333333');

        const clientCompany = bill.clientId.companyName || bill.clientId.name || 'N/A';
        doc.text(clientCompany, 310, startY + 15);

        if (bill.clientId.address) {
            const address = bill.clientId.address;
            // Split address into lines if it's long
            if (address.length > 50) {
                const addressPart1 = address.substring(0, 45);
                const addressPart2 = address.substring(45);
                doc.text(addressPart1, 310, startY + 30);
                doc.text(addressPart2, 310, startY + 45);
            } else {
                doc.text(address, 310, startY + 30);
            }
        }

        if (bill.clientId.gstNumber) {
            doc.text(`GSTIN: ${bill.clientId.gstNumber}`, 310, startY + 60);
        }
        if (bill.clientId.email) {
            doc.text(`Email: ${bill.clientId.email}`, 310, startY + 75);
        }
        if (bill.clientId.phone) {
            doc.text(`Phone: ${bill.clientId.phone}`, 310, startY + 90);
        }

        doc.moveDown(8);

        // ========== SERVICE DETAILS TABLE ==========
        const tableTop = doc.y;

        // Calculate taxable amount and GST
        const taxableAmount = bill.totalAmount - (bill.gstAmount || 0);
        const cgstAmount = (bill.gstAmount || 0) / 2;
        const sgstAmount = (bill.gstAmount || 0) / 2;
        const gstRate = taxableAmount > 0 ? (bill.gstAmount / taxableAmount) * 100 : 0;

        // Table Header - Matching sample
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');

        // Draw table header background
        doc.rect(50, tableTop, 500, 25).fill('#f0f0f0');
        doc.fillColor('#000000');

        doc.text('Item', 60, tableTop + 8);
        doc.text('GST Rate', 220, tableTop + 8);
        doc.text('Quantity', 320, tableTop + 8);
        doc.text('Rate', 390, tableTop + 8);
        doc.text('Amount', 460, tableTop + 8);
        doc.text('CGST', 510, tableTop + 8, { align: 'right', width: 40 });

        // Table Row
        let rowY = tableTop + 25;

        doc.rect(50, rowY, 500, 70).fill('#ffffff');
        doc.fillColor('#333333');
        doc.font('Helvetica').fontSize(9);

        // Service name and description
        doc.text('1.', 60, rowY + 10);
        doc.text(bill.serviceName || 'Service', 75, rowY + 10, { width: 130 });

        // Description
        if (bill.description) {
            doc.fontSize(8).fillColor('#666666');
            doc.text(bill.description, 75, rowY + 25, { width: 130 });
            doc.fontSize(9).fillColor('#333333');
        }

        // Table values
        doc.text(`${Math.round(gstRate)}%`, 220, rowY + 10);
        doc.text('1', 325, rowY + 10);

        const unitRate = taxableAmount;
        doc.text(`₹${unitRate.toLocaleString('en-IN')}`, 390, rowY + 10);
        doc.text(`₹${taxableAmount.toLocaleString('en-IN')}`, 460, rowY + 10);
        doc.text(`₹${cgstAmount.toLocaleString('en-IN')}`, 510, rowY + 10, { align: 'right' });

        doc.moveDown(5);

        // ========== AMOUNT SUMMARY SECTION ==========
        const summaryY = rowY + 90;

        doc.font('Helvetica').fontSize(9);

        // Amount row
        doc.text('Amount', 420, summaryY);
        doc.text(`₹${taxableAmount.toLocaleString('en-IN')}`, 510, summaryY, { align: 'right' });

        // CGST row
        doc.text(`CGST (${(gstRate / 2).toFixed(2)}%)`, 420, summaryY + 18);
        doc.text(`₹${cgstAmount.toLocaleString('en-IN')}`, 510, summaryY + 18, { align: 'right' });

        // SGST row
        doc.text(`SGST (${(gstRate / 2).toFixed(2)}%)`, 420, summaryY + 36);
        doc.text(`₹${sgstAmount.toLocaleString('en-IN')}`, 510, summaryY + 36, { align: 'right' });

        // Total row with border top
        doc.strokeColor('#000000').lineWidth(0.5)
            .moveTo(400, summaryY + 52)
            .lineTo(550, summaryY + 52)
            .stroke();

        doc.font('Helvetica-Bold');
        doc.text('Total (INR)', 420, summaryY + 58);
        doc.text(`₹${bill.totalAmount.toLocaleString('en-IN')}`, 510, summaryY + 58, { align: 'right' });

        // ========== BANK DETAILS SECTION ==========
        const bankY = summaryY + 95;

        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
        doc.text('Bank Details', 50, bankY);

        doc.font('Helvetica').fontSize(8).fillColor('#333333');
        doc.text('Account Name: VIRAL ADS MEDIA', 50, bankY + 15);
        doc.text('Account Number: 2402244856193850', 50, bankY + 28);
        doc.text('IFSC: AUBL0002448', 50, bankY + 41);
        doc.text('Account Type: Current', 50, bankY + 54);
        doc.text('Bank: AU Small Finance Bank', 50, bankY + 67);

        // ========== NOTES SECTION ==========
        if (bill.notes) {
            const notesY = bankY + 95;
            doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
            doc.text('Notes:', 50, notesY);
            doc.font('Helvetica').fontSize(8).fillColor('#666666');
            doc.text(bill.notes, 50, notesY + 12, { width: 500 });
        }

        // ========== AUTHORISED SIGNATORY SECTION ==========
        const footerY = doc.page.height - 80;

        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
        doc.text('Authorised Signatory', 50, footerY);

        // Thank you message
        doc.font('Helvetica').fontSize(8).fillColor('#666666');
        doc.text('Thank you for your business!', 250, footerY, { align: 'center' });

        // ========== FOOTER ==========
        doc.fontSize(7).font('Helvetica').fillColor('#999999');
        doc.text('For any enquiry, reach out via email at info@viraladsmedia.com, call on +91 93544 91934', 50, doc.page.height - 50, { align: 'center' });

        // Bottom border line
        doc.strokeColor('#000000').lineWidth(0.5)
            .moveTo(50, doc.page.height - 35)
            .lineTo(550, doc.page.height - 35)
            .stroke();

        doc.end();

    } catch (error) {
        console.error('Download bill error:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Server error while downloading bill',
                error: error.message
            });
        }
    }
};
// Edit bill (alias for update)
exports.editBill = async (req, res) => {
    return exports.updateBill(req, res);
};


// Add this function at the end of file
exports.forceDeleteBill = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('Force deleting bill with payments:', id);

        const deletedBill = await Bill.findByIdAndDelete(id);

        if (!deletedBill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        console.log('Force deleted bill:', deletedBill.billNumber, 'with', deletedBill.payments?.length, 'payments');

        return res.status(200).json({
            success: true,
            message: 'Bill and all associated payments deleted successfully',
            data: deletedBill
        });
    } catch (error) {
        console.error('Force delete error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};