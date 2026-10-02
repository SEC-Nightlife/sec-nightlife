import React, { useEffect, useState } from 'react';
import MenuPicker, { menuSelectionToPayload, menuSelectionChargeableTotal } from '@/components/menu/MenuPicker';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SERVICE_FEE_LABEL, serviceFeeForSubtotal, totalWithServiceFee } from '@/lib/serviceFee';

/**
 * Ask whether to add venue menu items before joining a hosted table.
 */
export default function HostedTableJoinWizard({
  open,
  onOpenChange,
  tableName = 'this table',
  venueMenu = [],
  entranceZar = 0,
  joinZar = 0,
  totalOnline = 0,
  isProcessing = false,
  requiresApproval = false,
  awaitingPayment = false,
  onConfirm,
}) {
  const [step, setStep] = useState('choice');
  const [menuSelected, setMenuSelected] = useState({});

  useEffect(() => {
    if (!open) return;
    if (requiresApproval && !awaitingPayment) {
      setStep('request');
      setMenuSelected({});
      return;
    }
    setStep(venueMenu.length ? 'choice' : 'checkout');
    setMenuSelected({});
  }, [open, venueMenu.length, requiresApproval, awaitingPayment]);

  const handleConfirm = () => {
    const payload = menuSelectionToPayload(venueMenu, menuSelected).map((p) => ({
      menuItemId: p.menuItemId,
      quantity: p.quantity,
    }));
    onConfirm?.(payload);
  };

  const menuTotal = menuSelectionChargeableTotal(venueMenu, menuSelected);
  const paySubtotal = (totalOnline > 0 ? totalOnline : entranceZar + joinZar) + menuTotal;
  const serviceFee = serviceFeeForSubtotal(paySubtotal);
  const payTotal = totalWithServiceFee(paySubtotal);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--sec-bg-card)] border border-[var(--sec-border)] max-w-md w-[calc(100vw-2rem)] sm:w-full">
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--sec-text-primary)' }}>
            {step === 'request' && 'Request to join'}
            {step === 'choice' && (awaitingPayment ? 'Complete your join' : 'Join this table')}
            {step === 'menu' && 'Choose menu items'}
            {step === 'checkout' && (awaitingPayment ? 'Review & pay' : 'Review & join')}
          </DialogTitle>
          <DialogDescription>
            {step === 'request' &&
              `This is a private table. The host must approve your request before you can pay or add menu items.`}
            {step === 'choice' &&
              (awaitingPayment
                ? `Your request was approved. Add items from the venue menu before paying to join ${tableName}.`
                : `Would you like to add items from the venue menu before joining ${tableName}?`)}
            {step === 'menu' && 'Optional — selected items appear on your table pass.'}
            {step === 'checkout' &&
              (awaitingPayment ? 'Confirm payment to join the table.' : 'Confirm before joining.')}
          </DialogDescription>
        </DialogHeader>

        {step === 'request' && (
          <div className="space-y-3 pt-2">
            {(entranceZar > 0 || joinZar > 0) && (
              <p className="text-sm text-[var(--sec-text-muted)]">
                {joinZar > 0 && `Joining fee R${joinZar.toFixed(0)}`}
                {entranceZar > 0 && joinZar > 0 ? ' + ' : ''}
                {entranceZar > 0 && `entrance R${entranceZar.toFixed(0)}`}
                {' '}will be due after the host approves your request.
              </p>
            )}
            <Button
              className="w-full h-12 sec-btn-accent font-semibold"
              disabled={isProcessing}
              onClick={() => onConfirm?.([])}
            >
              {isProcessing ? 'Sending…' : 'Send join request'}
            </Button>
          </div>
        )}

        {step === 'choice' && (
          <div className="flex flex-col gap-3 pt-2">
            <Button
              className="h-12 sec-btn-accent font-semibold"
              onClick={() => setStep('menu')}
            >
              Add menu items
            </Button>
            <Button
              variant="outline"
              className="h-12"
              onClick={() => setStep('checkout')}
            >
              Continue without menu
            </Button>
          </div>
        )}

        {step === 'menu' && (
          <div className="max-h-[min(60vh,320px)] overflow-y-auto">
            <MenuPicker
              items={venueMenu}
              selected={menuSelected}
              onChange={(id, qty) => setMenuSelected((s) => ({ ...s, [id]: qty }))}
            />
            <Button
              className="w-full mt-4 h-12 sec-btn-accent font-semibold"
              onClick={() => setStep('checkout')}
            >
              Continue
            </Button>
          </div>
        )}

        {step === 'checkout' && (
          <div className="space-y-3 pt-2">
            {entranceZar > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--sec-text-muted)]">Entrance</span>
                <span>R{entranceZar.toFixed(0)}</span>
              </div>
            )}
            {joinZar > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--sec-text-muted)]">Joining fee</span>
                <span>R{joinZar.toFixed(0)}</span>
              </div>
            )}
            {menuTotal > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--sec-text-muted)]">Menu items</span>
                <span>R{menuTotal.toFixed(0)}</span>
              </div>
            )}
            {serviceFee > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--sec-text-muted)]">{SERVICE_FEE_LABEL}</span>
                <span>R{serviceFee.toFixed(2)}</span>
              </div>
            )}
            {payTotal > 0 && (
              <div className="flex justify-between font-bold text-base pt-2 border-t border-[var(--sec-border)]">
                <span>Total due now</span>
                <span>R{payTotal.toFixed(2)}</span>
              </div>
            )}
            <Button
              className="w-full h-12 sec-btn-accent font-semibold"
              disabled={isProcessing}
              onClick={handleConfirm}
            >
              {isProcessing
                ? 'Processing…'
                : payTotal > 0
                  ? awaitingPayment
                    ? 'Pay to join'
                    : 'Pay and join'
                  : awaitingPayment
                    ? 'Confirm join'
                    : 'Join table'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
