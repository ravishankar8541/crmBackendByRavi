const ServiceBill = require('../models/ServiceBill');
const Bill = require('../models/Bill');

// Create or update service bill when a new bill is generated
exports.updateServiceBill = async (req, res) => {
    try {
        const { clientId, serviceName, totalAmount, billId, billNumber, initialPayment } = req.body;

        // Find existing service bill or create new
        let serviceBill = await ServiceBill.findOne({ 
            clientId: clientId, 
            serviceName: serviceName 
        });

        if (!serviceBill) {
            // CREATE NEW - first time bill
            serviceBill = new ServiceBill({
                clientId,
                serviceName,
                totalAmount: totalAmount,  // Fixed total amount
                paidAmount: initialPayment || 0,
                dueAmount: totalAmount - (initialPayment || 0)
            });
        } else {
            // UPDATE EXISTING - ONLY add payment, NEVER change total amount
            // ✅ FIX: Don't change totalAmount at all
            // serviceBill.totalAmount remains the SAME as first bill
            
            // Only add payment
            serviceBill.paidAmount += initialPayment || 0;
            serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
        }

        // Update status
        if (serviceBill.paidAmount >= serviceBill.totalAmount) {
            serviceBill.status = 'Paid';
        } else if (serviceBill.paidAmount > 0) {
            serviceBill.status = 'Partially Paid';
        }

        // Add bill reference (for history only)
        serviceBill.bills.push({
            billId: billId,
            billNumber: billNumber,
            amount: totalAmount,
            paymentReceived: initialPayment || 0,
            date: new Date()
        });

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

exports.getClientServiceBilling = async (req, res) => {
    try {
        const { clientId } = req.params;
        const serviceBills = await ServiceBill.find({ clientId: clientId });
        
        const processedServices = serviceBills.map(service => {
            // Sirf payments se paid amount calculate karo
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
                totalAmount: service.totalAmount,  // Yeh original amount hi rahega, kabhi badhega nahi
                paidAmount: totalPaid,
                dueAmount: dueAmount > 0 ? dueAmount : 0,
                status: dueAmount <= 0 ? 'Paid' : (totalPaid > 0 ? 'Partially Paid' : 'Pending'),
                payments: service.payments || [],
                bills: service.bills || []
            };
        });
        
        return res.status(200).json({
            success: true,
            data: {
                totalBilled: processedServices.reduce((sum, s) => sum + s.totalAmount, 0),
                totalPaid: processedServices.reduce((sum, s) => sum + s.paidAmount, 0),
                totalDue: processedServices.reduce((sum, s) => sum + s.dueAmount, 0),
                services: processedServices
            }
        });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ success: false, message: error.message, data: { services: [] } });
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