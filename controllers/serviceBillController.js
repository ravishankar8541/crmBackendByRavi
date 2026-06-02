const ServiceBill = require('../models/ServiceBill');
const Bill = require('../models/Bill');

// controllers/serviceBillController.js - FIXED VERSION

exports.updateServiceBill = async (req, res) => {
    try {
        const { clientId, serviceName, totalAmount, billId, billNumber, initialPayment } = req.body;

        let serviceBill = await ServiceBill.findOne({ 
            clientId: clientId, 
            serviceName: serviceName 
        });

        if (!serviceBill) {
            // CREATE NEW
            serviceBill = new ServiceBill({
                clientId,
                serviceName,
                totalAmount: totalAmount,
                paidAmount: initialPayment || 0,
                dueAmount: totalAmount - (initialPayment || 0),
                status: initialPayment >= totalAmount ? 'Paid' : (initialPayment > 0 ? 'Partially Paid' : 'Pending')
            });
        } else {
            // ✅ FIX: For installment bills, add to totalAmount
            const isNewBill = await Bill.findById(billId);
            
            if (isNewBill && isNewBill.status === 'Paid') {
                // This is an installment bill - add amount to total
                serviceBill.totalAmount += totalAmount;
            }
            
            serviceBill.paidAmount += initialPayment || 0;
            serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
            
            // ✅ FIX: Update status based on due amount
            if (serviceBill.dueAmount <= 0) {
                serviceBill.status = 'Paid';
            } else if (serviceBill.paidAmount > 0) {
                serviceBill.status = 'Partially Paid';
            } else {
                serviceBill.status = 'Pending';
            }
        }

        serviceBill.bills.push({
            billId: billId,
            billNumber: billNumber,
            amount: totalAmount,
            paymentReceived: initialPayment || 0,
            date: new Date()
        });

        if (initialPayment > 0) {
            serviceBill.payments.push({
                amount: initialPayment,
                paymentMethod: req.body.paymentMethod || 'Cash',
                transactionId: req.body.transactionId || '',
                remarks: req.body.paymentRemarks || 'Payment',
                receivedBy: req.user?.username || 'System',
                billNumber: billNumber,
                paymentDate: new Date()
            });
        }

        await serviceBill.save();

        return res.status(200).json({
            success: true,
            data: serviceBill
        });
    } catch (error) {
        console.error('Update service bill error:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// GET client service billing - FIXED to show correct due amount
exports.getClientServiceBilling = async (req, res) => {
    try {
        const { clientId } = req.params;
        const serviceBills = await ServiceBill.find({ clientId: clientId });
        
        const processedServices = serviceBills.map(service => {
            // Calculate total paid from payments array
            let totalPaid = 0;
            if (service.payments && service.payments.length > 0) {
                service.payments.forEach(payment => {
                    totalPaid += payment.amount || 0;
                });
            }
            
            const dueAmount = service.totalAmount - totalPaid;
            
            return {
                _id: service._id,
                serviceName: service.serviceName,
                totalAmount: service.totalAmount,
                paidAmount: totalPaid,
                dueAmount: dueAmount > 0 ? dueAmount : 0,
                status: dueAmount <= 0 ? 'Paid' : (totalPaid > 0 ? 'Partially Paid' : 'Pending'),
                payments: service.payments || [],
                bills: service.bills || []
            };
        });
        
        const totalBilled = processedServices.reduce((sum, s) => sum + s.totalAmount, 0);
        const totalPaid = processedServices.reduce((sum, s) => sum + s.paidAmount, 0);
        const totalDue = processedServices.reduce((sum, s) => sum + s.dueAmount, 0);
        
        return res.status(200).json({
            success: true,
            data: {
                totalBilled,
                totalPaid,
                totalDue,
                services: processedServices
            }
        });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ 
            success: false, 
            message: error.message, 
            data: { services: [] } 
        });
    }
};

exports.addServicePayment = async (req, res) => {
    try {
        const { serviceBillId } = req.params;
        const { amount, paymentMethod, transactionId, remarks, receivedBy, billNumber } = req.body;
        
        console.log('💰 Adding payment to service bill:', { serviceBillId, amount });
        
        const serviceBill = await ServiceBill.findById(serviceBillId);
        
        if (!serviceBill) {
            return res.status(404).json({
                success: false,
                message: 'Service bill not found'
            });
        }
        
        // Calculate new amounts
        const paymentAmount = parseFloat(amount);
        const oldPaidAmount = serviceBill.paidAmount;
        const newPaidAmount = oldPaidAmount + paymentAmount;
        
        serviceBill.paidAmount = newPaidAmount;
        serviceBill.dueAmount = serviceBill.totalAmount - newPaidAmount;
        
        // Update status
        if (serviceBill.paidAmount >= serviceBill.totalAmount) {
            serviceBill.status = 'Paid';
        } else if (serviceBill.paidAmount > 0) {
            serviceBill.status = 'Partially Paid';
        }
        
        // Add payment record with billNumber
        serviceBill.payments.push({
            amount: paymentAmount,
            paymentMethod: paymentMethod || 'Cash',
            transactionId: transactionId || '',
            remarks: remarks || `Installment payment`,
            receivedBy: receivedBy || 'System',
            billNumber: billNumber || `PAY-${Date.now()}`,
            paymentDate: new Date()
        });
        
        await serviceBill.save();
        
        console.log('✅ Payment added successfully:', {
            newPaidAmount: serviceBill.paidAmount,
            newDueAmount: serviceBill.dueAmount,
            status: serviceBill.status
        });
        
        return res.status(200).json({
            success: true,
            data: serviceBill,
            message: 'Payment added successfully'
        });
    } catch (error) {
        console.error('Add service payment error:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};